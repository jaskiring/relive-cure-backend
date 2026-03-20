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

// Export current Puppeteer session cookies (called from /api/export-refrens-cookies)
export async function getBrowserCookies() {
  const browser = await getBrowser();
  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();
  // Navigate to refrens.com to get its cookies
  if (!page.url().includes('refrens.com')) {
    await page.goto('https://www.refrens.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const cookies = await page.cookies();
  console.log('[CRM] Exported', cookies.length, 'cookies');
  return cookies;
}

export async function pushToCRM(lead) {
  console.log("[CRM] Starting push for:", lead.phone_number);
  if (!lead.id) lead.id = crypto.randomUUID();

  const browser = await getBrowser();
  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();
  
  try {
    // Inject session cookies (activeBusiness, __rt_check etc)
    const cookiesJson = process.env.REFRENS_COOKIES;
    if (cookiesJson) {
      try {
        const cookies = JSON.parse(cookiesJson);
        await page.setCookie(...cookies);
        console.log('[CRM] Session cookies restored');
      } catch (e) {
        console.warn('[CRM] Failed to parse REFRENS_COOKIES:', e.message);
      }
    }

    // Inject the __at JWT token into sessionStorage BEFORE the page loads
    // Refrens reads auth from sessionStorage.__at on app boot
    const refrensToken = process.env.REFRENS_TOKEN;
    if (refrensToken) {
      await page.evaluateOnNewDocument((token) => {
        sessionStorage.setItem('__at', token);
      }, refrensToken);
      console.log('[CRM] Session token injected via evaluateOnNewDocument');
    } else {
      console.warn('[CRM] REFRENS_TOKEN not set — session will likely fail');
    }

    await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log("STEP: Page opened");

    // DEBUG: Log what page Puppeteer actually landed on
    const finalUrl = page.url();
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || 'NO BODY');
    console.log('[CRM DEBUG] URL:', finalUrl);
    console.log('[CRM DEBUG] Title:', pageTitle);
    console.log('[CRM DEBUG] Body sample:', pageText.replace(/\n/g, ' '));

    // Detect login page — Refrens shows login at same URL without redirect
    const isLoginPage = pageTitle.toLowerCase().includes('login') ||
                        pageTitle.includes('401') ||
                        pageText.toLowerCase().includes('sign in with google') ||
                        finalUrl.includes('/login') || finalUrl.includes('/signin');

    if (isLoginPage) {
      console.log('[CRM] Login page detected — waiting for __rt_check auto-refresh...');
      try {
        // Refrens uses __rt_check cookie to silently refresh __at token.
        // Wait up to 12s for the token refresh to complete.
        await page.waitForFunction(
          () => !!sessionStorage.getItem('__at'),
          { timeout: 12000 }
        );
        console.log('[CRM] Session refreshed by __rt_check — reloading CRM form...');
        await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 90000 });
        const newTitle = await page.title();
        if (newTitle.toLowerCase().includes('login') || newTitle.includes('401')) {
          throw new Error('Session refresh failed — update REFRENS_COOKIES with fresh __rt_check cookie');
        }
      } catch (e) {
        if (e.message.includes('Session refresh failed') || e.message.includes('REFRENS_COOKIES')) throw e;
        throw new Error('Session expired and __rt_check refresh timed out — re-run: copy(sessionStorage.getItem("__at")) and update REFRENS_TOKEN on Render');
      }
    }

    console.log("crm opened without login");

    await new Promise(r => setTimeout(r, 2500));

    console.log('[CRM] Selecting Organisation...');
    // Wait for React to finish rendering the dropdown inputs
    await page.waitForSelector('.disco-select__control input', { timeout: 30000 });
    console.log('[CRM] Disco-selects are rendered');

    const orgInputHandle = await page.evaluateHandle(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find(l => l.innerText?.trim().includes('Prospect Organisation'));
      if (!label) {
        console.warn('[DOM] Prospect Organisation label not found');
        return null;
      }

      // Strategy 1: Navigate up to .css-rxk9pl row, then get the input in sibling column
      const row = label.closest('.css-rxk9pl');
      if (row) {
        const input = row.querySelector('.disco-select__control input');
        if (input) return input;
      }

      // Strategy 2: Proximity via getBoundingClientRect — find closest disco-select to label
      const labelRect = label.getBoundingClientRect();
      const allControls = Array.from(document.querySelectorAll('.disco-select__control'));
      let closest = null;
      let minDist = Infinity;
      for (const ctrl of allControls) {
        const rect = ctrl.getBoundingClientRect();
        const dist = Math.abs(rect.top - labelRect.top) + Math.abs(rect.left - labelRect.left);
        if (dist < minDist) { minDist = dist; closest = ctrl; }
      }
      if (closest) {
        const input = closest.querySelector('input');
        if (input) return input;
      }

      return null;
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
    const postSubmitUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const isSuccess = bodyText.includes('lead') || postSubmitUrl.includes('leads');

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
