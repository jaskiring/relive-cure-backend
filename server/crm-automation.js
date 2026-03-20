import puppeteer from 'puppeteer';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = "./puppeteer-session";

let browserInstance = null;

async function ensureChrome() {
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
  contactName: 'input[name="contact.name"]',
  contactPhone: 'input[name="contact.phone"]',
  customerCity: 'input[name="customer.city"]',
  subject: 'input[name="subject"]',
  details: 'textarea[name="details"]',
  submit: 'button[type="submit"]',
  vPhoneNumber: 'input[name="vendorFields.1.value"]',
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

// ─── Parse REFRENS_COOKIES env var ───────────────────────────────────────────
// Accepts either:
//   - A JSON array of cookie objects (correct format)
//   - A raw __rt JWT string (fallback — wraps it into a cookie object)
function parseCookies(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const cookies = JSON.parse(trimmed);
      console.log(`[CRM] Parsed ${cookies.length} cookies from REFRENS_COOKIES`);
      return cookies;
    } catch (e) {
      console.warn('[CRM] Failed to parse REFRENS_COOKIES as JSON array:', e.message);
      return null;
    }
  }

  // Fallback: treat as raw __rt JWT
  if (trimmed.startsWith('eyJ')) {
    console.warn('[CRM] REFRENS_COOKIES looks like a raw JWT — wrapping as __rt cookie');
    return [
      {
        name: '__rt',
        value: trimmed,
        domain: '.refrens.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      }
    ];
  }

  console.warn('[CRM] REFRENS_COOKIES format not recognised — skipping cookie injection');
  return null;
}

// ─── Wait for Refrens to exchange __rt cookie → __at in sessionStorage ────────
// Refrens JS performs a silent token refresh on app boot. This function
// navigates to the Refrens homepage (not the CRM form) and waits for that
// refresh to complete, so the CRM form navigation is already authenticated.
async function waitForTokenRefresh(page, timeoutMs = 20000) {
  console.log('[CRM] Navigating to Refrens homepage to trigger __rt → __at exchange...');
  await page.goto('https://www.refrens.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForFunction(
      () => {
        const at = sessionStorage.getItem('__at');
        return !!at && at.length > 20;
      },
      { timeout: timeoutMs, polling: 300 }
    );
    const at = await page.evaluate(() => sessionStorage.getItem('__at'));
    console.log('[CRM] __at token acquired — length:', at.length);
    return true;
  } catch (_) {
    console.warn('[CRM] __rt exchange timed out — __at not found in sessionStorage');
    return false;
  }
}

// Export current Puppeteer session cookies (called from /api/export-refrens-cookies)
export async function getBrowserCookies() {
  const browser = await getBrowser();
  const pages = await browser.pages();
  const page = pages.length ? pages[0] : await browser.newPage();
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
    // ── 1. Inject cookies BEFORE any navigation ──────────────────────────────
    // We must set cookies on the refrens.com domain first. Use a dummy URL
    // that the browser hasn't visited yet — setCookie works by domain, not URL.
    const cookies = parseCookies(process.env.REFRENS_COOKIES);
    if (cookies && cookies.length > 0) {
      const validCookies = cookies.filter(c => c.name && c.value && c.domain);
      await page.setCookie(...validCookies);
      console.log(`[CRM] Injected ${validCookies.length} cookies (incl. __rt refresh token)`);
    } else {
      console.warn('[CRM] No cookies to inject — session will likely fail');
    }

    // ── 2. Navigate to Refrens app root to trigger __rt → __at token exchange ─
    // Refrens JS reads the __rt cookie on boot and silently fetches a fresh
    // 15-min __at access token, storing it in sessionStorage. We MUST let this
    // happen before navigating to the CRM form, otherwise the form page sees
    // no valid session and redirects to login.
    const tokenReady = await waitForTokenRefresh(page, 20000);
    if (!tokenReady) {
      throw new Error(
        '__rt cookie did not produce a valid __at token. ' +
        'Your REFRENS_COOKIES may be expired or missing the __rt cookie. ' +
        'Please export fresh cookies from your browser and update REFRENS_COOKIES on Render.'
      );
    }

    // ── 3. Now navigate to the CRM form (already authenticated) ─────────────
    await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log("STEP: Page opened");

    const finalUrl = page.url();
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || 'NO BODY');
    console.log('[CRM DEBUG] URL:', finalUrl);
    console.log('[CRM DEBUG] Title:', pageTitle);
    console.log('[CRM DEBUG] Body sample:', pageText.replace(/\n/g, ' '));

    // ── 4. Sanity check — should not land on login page anymore ─────────────
    const isLoginPage =
      pageTitle.toLowerCase().includes('login') ||
      pageTitle.includes('401') ||
      pageText.toLowerCase().includes('sign in with google') ||
      finalUrl.includes('/login') ||
      finalUrl.includes('/signin');

    if (isLoginPage) {
      throw new Error(
        'Still on login page after token refresh. ' +
        'The __rt cookie may be tied to a different browser session or IP. ' +
        'Export fresh cookies from the browser currently logged into Refrens and update REFRENS_COOKIES.'
      );
    }

    console.log("CRM opened without login ✓");

    await new Promise(r => setTimeout(r, 2500));

    // ── 5. Select Organisation ───────────────────────────────────────────────
    console.log('[CRM] Selecting Organisation...');
    await page.waitForSelector('.disco-select__control input', { timeout: 30000 });
    console.log('[CRM] Disco-selects rendered');

    const orgInputHandle = await page.evaluateHandle(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find(l => l.innerText?.trim().includes('Prospect Organisation'));
      if (!label) return null;

      const row = label.closest('.css-rxk9pl');
      if (row) {
        const input = row.querySelector('.disco-select__control input');
        if (input) return input;
      }

      const labelRect = label.getBoundingClientRect();
      const allControls = Array.from(document.querySelectorAll('.disco-select__control'));
      let closest = null, minDist = Infinity;
      for (const ctrl of allControls) {
        const rect = ctrl.getBoundingClientRect();
        const dist = Math.abs(rect.top - labelRect.top) + Math.abs(rect.left - labelRect.left);
        if (dist < minDist) { minDist = dist; closest = ctrl; }
      }
      return closest ? closest.querySelector('input') : null;
    });

    const orgInput = orgInputHandle.asElement();
    if (!orgInput) throw new Error("Could not find Prospect Organisation input via label");

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
    await new Promise(r => setTimeout(r, 1500));

    const selectedOrgHandle = await page.evaluateHandle((input) => {
      const container = input.closest('.disco-select');
      return container ? container.querySelector('.disco-select__single-value')?.innerText : '';
    }, orgInput);
    const orgValue = await selectedOrgHandle.jsonValue();
    if (!orgValue || orgValue.length < 2) throw new Error("Organisation not selected");
    console.log("STEP: Organisation selected:", orgValue);

    // ── 6. Fill fields ───────────────────────────────────────────────────────
    await fillField(page, SEL.contactName, lead.contact_name || lead.name || 'Session Test');
    await fillField(page, SEL.contactPhone, lead.phone_number);
    await fillField(page, SEL.customerCity, lead.city || 'Delhi');
    await fillField(page, SEL.subject, `LASIK Session Test - ${lead.phone_number}`);
    await fillField(page, SEL.details, `Session persistence test | phone=${lead.phone_number}`);
    await fillField(page, SEL.vPhoneNumber, lead.phone_number);
    console.log("STEP: Fields filled");
    await new Promise(r => setTimeout(r, 1500));

    // ── 7. Submit ────────────────────────────────────────────────────────────
    console.log('[CRM] Clicking submit...');
    await page.click(SEL.submit);
    console.log("STEP: Form submitted");

    await new Promise(r => setTimeout(r, 4000));
    const postSubmitUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const isSuccess = bodyText.includes('lead') || postSubmitUrl.includes('leads');
    if (isSuccess) console.log("✓ Lead form submitted successfully");

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