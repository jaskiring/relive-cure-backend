import puppeteer from 'puppeteer';
import crypto from 'crypto';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = process.env.USER_DATA_DIR || '/opt/render/.cache/puppeteer-session';

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    const executablePath = puppeteer.executablePath();
    browserInstance = await puppeteer.launch({
      headless: true,
      slowMo: 0,
      executablePath,
      userDataDir: USER_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1280,900"
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
  orgInput:     '#react-select-3-input',

  vPhoneNumber:  'input[name="vendorFields.1.value"]',
  vTimeline:     'input[name="vendorFields.2.value"]',
  vPrefCity:     'input[name="vendorFields.4.value"]',
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
  const page = await browser.newPage();
  
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    if (page.url().includes('login') || page.url().includes('signin')) {
      console.error('[CRM] ❌ SESSION EXPIRED');
      await page.close();
      return { success: false, id: lead.id, error: 'Session expired' };
    }

    console.log('[CRM] Selecting Organisation...');
    await page.waitForSelector(SEL.orgInput, { timeout: 10000 });
    await page.click(SEL.orgInput);
    
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 300));
    
    await page.type(SEL.orgInput, 'a');
    await new Promise(r => setTimeout(r, 1200));
    
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 500));
    
    const selectedOrg = await page.evaluate(() => {
      return document.querySelector('.disco-select__single-value')?.innerText || '';
    });
    
    if (!selectedOrg || selectedOrg.length < 2) {
      throw new Error("Organisation not selected");
    }
    console.log(`[CRM] ✅ Org verified: "${selectedOrg}"`);

    await fillField(page, SEL.contactName, lead.contact_name || lead.name || 'Test Lead');
    await fillField(page, SEL.contactPhone, lead.phone_number);
    await fillField(page, SEL.customerCity, lead.city || 'Mumbai');
    await fillField(page, SEL.subject, `LASIK Test - ${lead.phone_number}`);
    await fillField(page, SEL.details, `Test lead | phone=${lead.phone_number}`);
    await fillField(page, SEL.vPhoneNumber, lead.phone_number);

    console.log('[CRM] Clicking submit...');
    await page.click(SEL.submit);
    
    await new Promise(r => setTimeout(r, 4000));
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const isSuccess = bodyText.includes('lead') || finalUrl.includes('leads');

    await page.close();
    return { success: isSuccess, id: lead.id };

  } catch (error) {
    console.error("[CRM ERROR]", error.message);
    await page.close();
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
