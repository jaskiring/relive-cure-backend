import puppeteer from 'puppeteer';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = "./puppeteer-session";

let browserInstance = null;

async function ensureChrome() {
  // Check if puppeteer Chrome is already present
  try {
    const path = puppeteer.executablePath();
    if (fs.existsSync(path)) {
      console.log('[CRM] Chrome found at:', path);
      return path;
    }
    console.warn('[CRM] Chrome not found at expected path:', path);
  } catch (e) {
    console.warn('[CRM] executablePath() error:', e.message);
  }

  // Try system Chrome first (faster)
  const systemPaths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log('[CRM] Using system Chrome:', p);
      return p;
    }
  }

  // Install Chrome at runtime — handles Render container restarts wiping the build cache
  console.log('[CRM] Chrome missing — installing now...');
  try {
    execSync('npx puppeteer browsers install chrome', {
      stdio: 'inherit',
      timeout: 120000
    });
    const path = puppeteer.executablePath();
    if (fs.existsSync(path)) {
      console.log('[CRM] Chrome installed successfully:', path);
      return path;
    }
  } catch (err) {
    console.error('[CRM] Chrome install failed:', err.message);
  }

  console.warn('[CRM] Falling back to Puppeteer auto-detect');
  return undefined;
}

async function getBrowser() {
  if (!browserInstance) {
    console.log("Using session dir:", USER_DATA_DIR);
    const executablePath = await ensureChrome();
    browserInstance = await puppeteer.launch({
      headless: true,
      slowMo: 0,
      ...(executablePath ? { executablePath } : {}),
      userDataDir: USER_DATA_DIR,
      defaultViewport: null,
      args: [
        "--start-maximized", 
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ],
      timeout: 60000
    });
  }
  return browserInstance;
}

const SEL = {
  contactName:  'input[name="contact.name"]',
  contactPhone: 'input[name="contact.phone"]',
  customerCity: 'input[name="customer.city"]',
  subject:      'input[name="subject"]',
  details:      'textarea[name="details"]',
  submit:       'button[type="submit"]',
  vPhoneNumber:  'input[name="vendorFields.1.value"]',
};

async function fillField(page, selector, value) {
  if (!value) return false;
  try {
    await page.waitForSelector(selector, { timeout: 6000 });
    await page.type(selector, String(value));
    return true;
  } catch (e) {
    return false;
  }
}

export async function pushToCRM(lead) {
  console.log("[CRM] Starting push for:", lead.phone_number);
  if (!lead.id) lead.id = crypto.randomUUID();

  const browser = await getBrowser();
  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();
  
  try {
    // Reset page before use
    await page.goto("about:blank");
    await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log("STEP: Page opened");

    // Hard session check
    if (page.url().includes("login") || page.url().includes("signin")) {
      throw new Error("Session expired - login required");
    }
    console.log("crm opened without login");

    await new Promise(r => setTimeout(r, 2500));

    console.log('[CRM] Selecting Organisation...');
    const orgInputHandle = await page.evaluateHandle(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find(l => l.innerText.includes('Prospect Organisation'));
      if (!label) return null;

      // Row-based traversal: Find the row container and the 2nd column
      const row = label.closest('.css-rxk9pl');
      const inputCol = row ? row.children[1] : null;
      return inputCol ? inputCol.querySelector('.disco-select__control input') : null;
    });

    const orgInput = orgInputHandle.asElement();
    if (!orgInput) {
      throw new Error("Could not find Prospect Organisation input via label");
    }

    await orgInput.click();
    
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 300));
    
    await page.keyboard.type('r');
    await new Promise(r => setTimeout(r, 1200));
    
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 1500)); // Delay after major step
    
    const selectedOrgHandle = await page.evaluateHandle((input) => {
      const container = input.closest('.disco-select');
      return container ? container.querySelector('.disco-select__single-value')?.innerText : '';
    }, orgInput);
    
    const orgValue = await selectedOrgHandle.jsonValue();
    if (!orgValue || orgValue.length < 2) {
      throw new Error("Organisation not selected");
    }
    console.log("STEP: Organisation selected");
    console.log("Selected Organisation:", orgValue);

    await fillField(page, SEL.contactName, lead.contact_name || lead.name || 'Session Test');
    await fillField(page, SEL.contactPhone, lead.phone_number);
    await fillField(page, SEL.customerCity, lead.city || 'Delhi');
    await fillField(page, SEL.subject, `LASIK Session Test - ${lead.phone_number}`);
    await fillField(page, SEL.details, `Session persistence test | phone=${lead.phone_number}`);
    await fillField(page, SEL.vPhoneNumber, lead.phone_number);
    console.log("STEP: Fields filled");
    await new Promise(r => setTimeout(r, 1500));

    console.log('[CRM] Clicking submit...');
    await page.click(SEL.submit);
    console.log("STEP: Form submitted");
    
    await new Promise(r => setTimeout(r, 4000));
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const isSuccess = bodyText.includes('lead') || finalUrl.includes('leads');

    if (isSuccess) console.log("form submitted");

    return { success: isSuccess, id: lead.id, selectedOrg: orgValue };

  } catch (error) {
    console.error("[CRM ERROR]", error.message);
    return { success: false, id: lead.id, error: error.message };
  }
}

export async function processQueue(leads, concurrencyLimit = 2) {
  const results = [];
  const queue = [...leads];
  const active = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrencyLimit && queue.length > 0) {
      const lead = queue.shift();
      const promise = pushToCRM(lead).then(result => {
        active.splice(active.indexOf(promise), 1);
        return result;
      });
      active.push(promise);
      results.push(promise);
    }
    if (active.length > 0) await Promise.race(active);
  }

  return Promise.all(results);
}
