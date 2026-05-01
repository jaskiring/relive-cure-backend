import puppeteer from 'puppeteer';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';
import PQueue from 'p-queue';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = process.env.PUPPETEER_SESSION_DIR || "./puppeteer-session";

const queue = new PQueue({
  concurrency: 3,
  intervalCap: 6,      // max 6 tasks per interval
  interval: 10000      // per 10s
});

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), ms))
  ]);
}

let browserInstance = null;

async function ensureChrome() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/src/.cache/puppeteer';
  
  try {
    const { execSync: exec } = await import('child_process');
    const found = exec(`find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
    if (found && fs.existsSync(found)) {
      console.log('[CRM] Chrome found in custom cache:', found);
      return found;
    }
  } catch (e) {}

  try {
    const path = puppeteer.executablePath();
    if (fs.existsSync(path)) return path;
  } catch (e) {}

  const systemPaths = [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }

  console.log('[CRM] Chrome missing — installing now...');
  try {
    execSync('npx puppeteer browsers install chrome', { stdio: 'inherit', timeout: 120000, env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir } });
    try {
      const { execSync: exec } = await import('child_process');
      const found = exec(`find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch (e) {}
    const path = puppeteer.executablePath();
    if (fs.existsSync(path)) return path;
  } catch (err) {}

  return undefined;
}

let browserInstancePromise = null;

async function getBrowser() {
  if (!browserInstancePromise) {
    browserInstancePromise = (async () => {
      console.log("Using session dir:", USER_DATA_DIR);
      const executablePath = await ensureChrome();
      return await puppeteer.launch({
        headless: true,
        slowMo: 0,
        ...(executablePath ? { executablePath } : {}),
        userDataDir: USER_DATA_DIR,
        defaultViewport: null,
        args: [
          "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
          "--disable-gpu", "--disable-software-rasterizer", "--disable-extensions",
          "--disable-background-networking", "--disable-default-apps", "--disable-sync",
          "--disable-translate", "--hide-scrollbars", "--metrics-recording-only",
          "--mute-audio", "--no-first-run", "--safebrowsing-disable-auto-update",
          "--single-process", "--memory-pressure-off", "--js-flags=--max-old-space-size=256",
          "--start-maximized"
        ],
        timeout: 60000
      });
    })();
  }
  return browserInstancePromise;
}

const SEL = {
  contactName: 'input[name="contact.name"]',
  contactPhone: 'input[name="contact.phone"]',
  customerCity: 'input[name="customer.city"]',
  subject: 'input[name="subject"]',
  details: 'textarea[name="details"]',
  submit: 'button[type="submit"]',
  vPhoneNumber: 'input[name="vendorFields.1.value"]',
};

async function fillField(page, selector, value) {
  if (!value && value !== 0) return false;
  try {
    await page.waitForSelector(selector, { timeout: 3000 });
    await page.$eval(selector, el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type(selector, String(value), { delay: 10 });
    return true;
  } catch (e) {
    console.warn(`[CRM] Failed to fill field ${selector}: ${e.message}`);
    return false;
  }
}

async function fillCustomField(page, labelText, value) {
  if (!value && value !== 0) return false;
  try {
    const filled = await page.evaluate((label, val) => {
      const labels = Array.from(document.querySelectorAll('label, .label, [class*="label"]'));
      const match = labels.find(l => l.textContent.trim().toLowerCase().includes(label.toLowerCase()));
      if (!match) return false;
      let el = match.nextElementSibling;
      if (!el || !['INPUT','TEXTAREA'].includes(el.tagName)) {
        el = match.parentElement?.querySelector('input, textarea');
      }
      if (!el) return false;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, labelText, String(value));
    return filled;
  } catch (e) {
    return false;
  }
}

function parseCookies(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (e) { return null; }
  }
  if (trimmed.startsWith('eyJ')) {
    return [{ name: '__rt', value: trimmed, domain: '.refrens.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' }];
  }
  return null;
}

async function waitForTokenRefresh(page, timeoutMs = 20000) {
  await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  try {
    await page.waitForFunction(() => {
      const at = sessionStorage.getItem('__at');
      return !!at && at.length > 20;
    }, { timeout: timeoutMs, polling: 300 });
    return true;
  } catch (_) {
    return false;
  }
}

function getStage(intent_level) {
  const lvl = (intent_level || "").toUpperCase();
  if (lvl === "HOT") return "New";
  if (lvl === "WARM") return "Open";
  if (lvl === "COLD") return "Lost";
  return "New";
}

async function selectDropdownByLabel(page, keywords, value) {
  try {
    const controlHandle = await page.evaluateHandle((labels) => {
      const elements = Array.from(document.querySelectorAll('label, div, span, p'));
      for (const el of elements) {
        const text = (el.innerText || '').trim().toLowerCase();
        if (labels.some(l => text === l.toLowerCase() || text.startsWith(l.toLowerCase() + ' '))) {
          let container = el;
          for (let i = 0; i < 5 && container; i++) {
            const select = container.querySelector('.disco-select__control');
            if (select) return select;
            container = container.parentElement;
          }
        }
      }
      return null;
    }, keywords);

    if (!controlHandle || !controlHandle.asElement()) return false;
    await controlHandle.click();
    await page.waitForSelector('.disco-select__option', { timeout: 3000 });
    
    if (value) {
      await page.keyboard.type(String(value), { delay: 10 });
      await new Promise(r => setTimeout(r, 200)); 
    }

    const clicked = await page.evaluate((val) => {
      const options = Array.from(document.querySelectorAll('.disco-select__option'));
      if (val) {
        const exact = options.find(o => o.innerText.trim().toLowerCase() === val.toLowerCase());
        if (exact) { exact.click(); return true; }
        const partial = options.find(o => o.innerText.trim().toLowerCase().includes(val.toLowerCase()));
        if (partial) { partial.click(); return true; }
      }
      if (options.length > 0) { options[0].click(); return true; }
      return false;
    }, String(value));

    if (!clicked) {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
    }
    return true;
  } catch(e) {
    return false;
  }
}

async function assertValue(page, selector, expected) {
  const val = await page.$eval(selector, el => el.value || el.innerText);
  if (!val || !val.toString().toLowerCase().includes(expected.toString().toLowerCase().slice(0,4))) {
    throw new Error(`Validation failed for ${selector}. Expected ${expected}, got ${val}`);
  }
}

export async function getBrowserCookies() {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto('https://www.refrens.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.cookies();
  } finally {
    await context.close();
  }
}

async function processLead(lead) {
  const t_open = Date.now();
  console.log(`[CRM] Starting push for lead_id=${lead.id || 'new'}, phone=${lead.phone_number}`);
  if (!lead.id) lead.id = crypto.randomUUID();

  const realName = (lead.contact_name || lead.name || '').trim().replace(/^(WhatsApp Lead|Session Test)$/i, '').trim()
    || `Lead-${(lead.phone_number || '').slice(-4)}`;

  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    const cookies = parseCookies(process.env.REFRENS_COOKIES);
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));
    }

    const tokenReady = await waitForTokenRefresh(page, 10000);
    if (!tokenReady) throw new Error('__rt exchange failed or timed out');

    const capturedToken = await page.evaluate(() => sessionStorage.getItem('__at'));
    await page.evaluateOnNewDocument((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);

    await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    await page.evaluate((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);
    
    await page.waitForSelector('.disco-select__control', { timeout: 10000 });
    const controls = await page.$$('.disco-select__control');
    if (controls.length >= 2) {
      const orgControl = controls[1];
      await orgControl.click();
      await page.waitForSelector('.disco-select__option', { timeout: 3000 });
      await page.evaluate(() => {
        const opt = document.querySelector('.disco-select__option');
        if (opt) opt.click();
      });
    }

    const t_fill = Date.now();

    const stage = getStage(lead.intent_level);
    const stageSet = await selectDropdownByLabel(page, ['stage', 'status', 'lead status', 'pipeline'], stage);
    if (!stageSet) throw new Error('Stage not set');

    const cleanPhone = (lead.phone_number || '').replace(/^\+91/, '').replace(/^91(?=\d{10})/, '').trim();
    await fillField(page, SEL.contactName, realName);
    await fillField(page, SEL.contactPhone, cleanPhone);
    
    if (lead.city) {
      await fillField(page, SEL.customerCity, lead.city);
    } else {
      await fillField(page, SEL.customerCity, 'Delhi'); 
    }

    const subjectPrefix = !!(lead.is_test || (lead.contact_name || '').includes('TEST')) ? '[TEST] ' : '';
    await fillField(page, SEL.subject, `${subjectPrefix}LASIK Lead - ${realName} - ${cleanPhone}`);
    
    const notes = [
      `Assignee: ${lead.assignee || 'Unassigned'}`,
      `Timeline: ${lead.timeline || 'N/A'}`,
      `Insurance: ${lead.insurance || 'N/A'}`,
      `Intent: ${lead.intent_level || 'N/A'}`,
      `Source: ${lead.source || 'whatsapp_bot'}`,
      `Last Message: ${lead.last_user_message || 'N/A'}`,
      lead.remarks ? `Remarks: ${lead.remarks}` : ''
    ].filter(Boolean).join('\n');
    await fillField(page, SEL.details, notes);

    if (lead.preferred_surgery_city) {
      const set = await fillCustomField(page, 'surgery city', lead.preferred_surgery_city) || await fillCustomField(page, 'preferred city', lead.preferred_surgery_city);
      if (!set) await fillField(page, SEL.details, notes + `\nSurgery City: ${lead.preferred_surgery_city}`);
    }
    if (lead.timeline) await fillCustomField(page, 'timeline', lead.timeline);
    if (lead.insurance) await fillCustomField(page, 'insurance', lead.insurance);
    
    await fillField(page, SEL.vPhoneNumber, cleanPhone);

    await assertValue(page, SEL.contactName, realName);
    await assertValue(page, SEL.contactPhone, cleanPhone);
    
    const t_submit = Date.now();

    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    });

    await Promise.all([
      page.waitForNavigation({ timeout: 10000 }).catch(() => {}), 
      page.click(SEL.submit)
    ]);
    
    const postSubmitUrl = page.url();
    const urlChanged = !postSubmitUrl.endsWith('/new') && !postSubmitUrl.endsWith('/new/');
    
    if (!urlChanged) {
      const postBodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
      if (postBodyText.includes('is a required field') || postBodyText.includes('invalid')) {
        throw new Error('Form validation error on submit');
      }
      throw new Error('Submit clicked but URL did not change');
    }

    const t_done = Date.now();
    console.log(`[CRM] lead_id=${lead.id} t_open=${t_fill - t_open}ms t_fill=${t_submit - t_fill}ms t_submit=${t_done - t_submit}ms t_done=${t_done - t_open}ms`);

    return { success: true, id: lead.id };

  } catch (error) {
    console.error(`[CRM ERROR] lead_id=${lead.id}:`, error.message);
    throw error; 
  } finally {
    await context.close();
  }
}

export async function processQueue(leads, concurrencyLimit = 3) {
  const results = [];
  queue.concurrency = concurrencyLimit;
  
  for (const lead of leads) {
    console.log(`[QUEUE] Queueing lead ${lead.id}. pending=${queue.pending} size=${queue.size}`);
    const promise = queue.add(() => 
      withTimeout(processLead(lead), 10000).catch(finalErr => {
        console.error(`[QUEUE] Lead ${lead.id} failed: ${finalErr.message}`);
        return { success: false, id: lead.id, error: finalErr.message };
      })
    );
    results.push(promise);
  }

  return Promise.all(results);
}

export const pushToCRM = processLead;