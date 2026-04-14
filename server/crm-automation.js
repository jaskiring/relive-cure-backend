import puppeteer from 'puppeteer';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = process.env.PUPPETEER_SESSION_DIR || "./puppeteer-session";

let browserInstance = null;

async function ensureChrome() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/src/.cache/puppeteer';
  
  // First check our custom cache directory directly
  const customPaths = [
    `${cacheDir}/chrome/linux-146.0.7680.76/chrome-linux64/chrome`,
    `${cacheDir}/chrome/linux-*/chrome-linux64/chrome`,
  ];
  
  // Use glob-style search in the cache dir
  try {
    const { execSync: exec } = await import('child_process');
    const found = exec(`find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
    if (found && fs.existsSync(found)) {
      console.log('[CRM] Chrome found in custom cache:', found);
      return found;
    }
  } catch (e) {
    console.warn('[CRM] Cache dir search failed:', e.message);
  }

  // Try puppeteer's own executablePath
  try {
    const path = puppeteer.executablePath();
    if (fs.existsSync(path)) {
      console.log('[CRM] Chrome found at:', path);
      return path;
    }
    console.warn('[CRM] Chrome not found at puppeteer path:', path);
  } catch (e) {
    console.warn('[CRM] executablePath() error:', e.message);
  }

  // Try system Chrome
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

  // Install Chrome as last resort
  console.log('[CRM] Chrome missing — installing now...');
  try {
    execSync('npx puppeteer browsers install chrome', {
      stdio: 'inherit',
      timeout: 120000,
      env: {
        ...process.env,
        PUPPETEER_CACHE_DIR: cacheDir
      }
    });
    // Search again after install
    try {
      const { execSync: exec } = await import('child_process');
      const found = exec(`find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (found && fs.existsSync(found)) {
        console.log('[CRM] Chrome installed and found at:', found);
        return found;
      }
    } catch (e) {}
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
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--safebrowsing-disable-auto-update",
        "--single-process",
        "--memory-pressure-off",
        "--js-flags=--max-old-space-size=256",
        "--start-maximized"
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
async function waitForTokenRefresh(page, timeoutMs = 30000) {
  console.log('[CRM] Navigating to Refrens homepage to trigger __rt → __at exchange...');
  await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });

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

function getAssignedRep(lead) {
  const city = (lead.city || "").toLowerCase();
  if (city === "delhi") return "Delhi Sales";
  if (lead.intent_level === "HOT" || lead.request_call === true) return "Senior Sales";
  return "General Queue";
}

async function selectDropdownByLabel(page, keywords, value) {
  try {
    const controlHandle = await page.evaluateHandle((labels) => {
      const elements = Array.from(document.querySelectorAll('label, div, span, p'));
      let targetElement = null;
      for (const el of elements) {
        const text = (el.innerText || '').trim().toLowerCase();
        if (labels.some(l => text === l.toLowerCase() || text.startsWith(l.toLowerCase() + ' '))) {
          targetElement = el;
          break;
        }
      }
      if (!targetElement) return null;
      
      let container = targetElement;
      for (let i = 0; i < 5 && container; i++) {
        const select = container.querySelector('.disco-select__control');
        if (select) return select;
        container = container.parentElement;
      }
      return null;
    }, keywords);

    if (!controlHandle || !controlHandle.asElement()) {
      return false;
    }

    await controlHandle.click();
    await new Promise(r => setTimeout(r, 500));

    if (value) {
      await page.keyboard.type(String(value), { delay: 50 });
      await new Promise(r => setTimeout(r, 1000));
    }

    const clicked = await page.evaluate(() => {
      const option = document.querySelector('.disco-select__option');
      if (option) { option.click(); return true; }
      return false;
    });

    if (!clicked) {
      await page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 300));
      await page.keyboard.press('Enter');
    }

    return true;
  } catch(e) {
    console.warn(`[CRM] Dropdown fallback safely skipped. Keywords: ${keywords.join(', ')}`, e.message);
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

  // Use best available name — phone number as last resort so dashboard sync always works
  const realName = (lead.contact_name || lead.name || '').trim().replace(/^(WhatsApp Lead|Session Test)$/i, '').trim()
    || `Lead-${(lead.phone_number || '').slice(-4)}`;

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
        'Please export fresh cookies from your browser and update REFRENS_COOKIES.'
      );
    }

    // Capture the token BEFORE navigating away — sessionStorage clears on navigation
    const capturedToken = await page.evaluate(() => sessionStorage.getItem('__at'));
    console.log('[CRM] Captured __at token for re-injection, length:', capturedToken?.length);

    // Pre-inject token so it exists when CRM form page loads
    await page.evaluateOnNewDocument((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);

    // ── 3. Now navigate to the CRM form (already authenticated) ─────────────
    await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    // Re-inject token after navigation as well (belt and suspenders)
    await page.evaluate((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);
    
    await new Promise(r => setTimeout(r, 1000));
    console.log("STEP: Page opened");


    const finalUrl = page.url();
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || 'NO BODY');
    console.log('[CRM DEBUG] URL:', finalUrl);
    console.log('[CRM DEBUG] Title:', pageTitle);
    console.log('[CRM DEBUG] Body sample:', pageText.replace(/\n/g, ' '));

    // Guard: if page is blank, React didn't hydrate — fail loudly instead of silently
    if (!pageTitle || pageTitle.trim() === '' || pageText === 'NO BODY') {
      throw new Error(
        'CRM page loaded blank — React SPA did not hydrate on time. ' +
        'Check if __at token is valid and Refrens is accessible from Render.'
      );
    }

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
    console.log('[CRM] Memory usage:', JSON.stringify(process.memoryUsage()));

    await new Promise(r => setTimeout(r, 1000));

    // ── 5. Select Organisation ───────────────────────────────────────────────
    console.log('[CRM] Selecting Organisation...');
    await page.waitForSelector('.disco-select__control', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 800));

    // Prospect Organisation is confirmed as disco-select index 1
    const controls = await page.$$('.disco-select__control');
    if (controls.length < 2) throw new Error('Expected at least 2 disco-selects, found: ' + controls.length);
    
    const orgControl = controls[1]; // index 1 = Prospect Organisation
    
    // Click the control first
    await orgControl.click();
    await new Promise(r => setTimeout(r, 500));
    
    // Then click the input inside it
    const orgInput = await orgControl.$('input');
    if (orgInput) {
      await orgInput.click();
      await new Promise(r => setTimeout(r, 300));
    }
    
    // Type to search
    await page.keyboard.type('R', { delay: 200 });
    await new Promise(r => setTimeout(r, 1500));
    
    // Check if options appeared
    const options = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.disco-select__option'))
        .map(o => o.innerText?.trim());
    });
    console.log('[CRM] Options after typing R:', JSON.stringify(options));
    
    if (options.length > 0) {
      // Click first option — any organisation is fine
      await page.evaluate(() => {
        const opt = document.querySelector('.disco-select__option');
        if (opt) opt.click();
      });
    } else {
      // Fallback: open dropdown and pick first option with ArrowDown
      await page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 500));
      await page.keyboard.press('Enter');
    }
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Accept ANY selected value — organisation field just needs to be filled
    const orgValue = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('.disco-select__control'));
      const orgCtrl = controls[1];
      return orgCtrl?.querySelector('[class*="single-value"]')?.innerText?.trim() || '';
    });
    
    console.log('[CRM] Organisation selected:', orgValue);
    if (!orgValue || orgValue.length < 2) throw new Error('Organisation still empty after selection attempt');
    console.log('STEP: Organisation selected:', orgValue);

    // ── 6. Set Dropdowns (Stage & Assignment) ───────────────────────────────
    console.log('[CRM] Setting Lead Stage to New...');
    const stageSet = await selectDropdownByLabel(page, ['stage', 'status', 'lead status', 'pipeline'], 'New');
    if (stageSet) {
      console.log('[CRM] Stage set: New');
    } else {
      console.log('[CRM] Stage field not found — fail safe continued');
    }

    const repToAssign = getAssignedRep(lead);
    console.log(`[CRM] Assigning lead to: ${repToAssign}...`);
    const assigneeSet = await selectDropdownByLabel(page, ['assign', 'owner', 'responsible'], repToAssign);
    if (assigneeSet) {
      console.log(`[CRM] Assigned to: ${repToAssign}`);
    } else {
      console.log('[CRM] Assignee field not found — fail safe continued');
    }

    // ── 7. Fill structured fields ────────────────────────────────────────────
    await fillField(page, SEL.contactName, realName);
    const cleanPhone = (lead.phone_number || '')
      .replace(/^\+91/, '')
      .replace(/^91(?=\d{10})/, '')
      .trim();
    
    await fillField(page, SEL.contactPhone, cleanPhone);
    await page.waitForSelector(SEL.customerCity, { timeout: 8000 });
    await fillField(page, SEL.customerCity, lead.city || 'Delhi');
    await fillField(page, SEL.subject, `LASIK Lead - ${realName} - ${lead.phone_number}`);
    
    const structuredDetails = [
      `--- LEAD INFO ---`,
      `Name: ${realName}`,
      `Phone: ${lead.phone_number || 'N/A'}`,
      `City: ${lead.city || 'N/A'}`,
      `Surgery City: ${lead.preferred_surgery_city || 'N/A'}`,
      `Timeline: ${lead.timeline || 'N/A'}`,
      `Insurance: ${lead.insurance || 'N/A'}`,
      ``,
      `--- INTENT ---`,
      `Intent Level: ${lead.intent_level || 'N/A'}`,
      `Urgency: ${lead.urgency_level || 'N/A'}`,
      `Requested Call: ${lead.request_call ? 'YES' : 'NO'}`,
      ``,
      `--- CONCERNS ---`,
      `Cost: ${lead.interest_cost ? 'YES' : 'NO'}`,
      `Recovery: ${lead.interest_recovery ? 'YES' : 'NO'}`,
      `Pain: ${lead.concern_pain ? 'YES' : 'NO'}`,
      `Safety: ${lead.concern_safety ? 'YES' : 'NO'}`,
      `Power: ${lead.concern_power ? 'YES' : 'NO'}`,
      ``,
      `--- CONTEXT ---`,
      `Last Message: ${lead.last_user_message || 'N/A'}`,
    ].join('\n');
    
    await fillField(page, SEL.details, structuredDetails);
    await fillField(page, SEL.vPhoneNumber, lead.phone_number);
    console.log("[CRM] Structured data injected & fields filled");
    await new Promise(r => setTimeout(r, 500));

    // ── 8. Submit ────────────────────────────────────────────────────────────
    console.log('[CRM] Clicking submit...');
    
    // Scroll submit button into view first
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise(r => setTimeout(r, 500));
    
    // Log what the submit button looks like
    const submitBtnInfo = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      return btn ? { text: btn.innerText, disabled: btn.disabled, visible: btn.offsetParent !== null } : null;
    });
    console.log('[CRM] Submit button:', JSON.stringify(submitBtnInfo));
    
    // Click submit
    await page.click(SEL.submit);
    await new Promise(r => setTimeout(r, 1000));
    
    // If URL still /new, try clicking again
    const urlAfterFirstClick = page.url();
    if (urlAfterFirstClick.includes('/new')) {
      console.log('[CRM] First click did not navigate, trying again...');
      await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log("STEP: Form submitted");

    await new Promise(r => setTimeout(r, 6000));
    const postSubmitUrl = page.url();
    const postTitle = await page.title();
    const postBodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    
    console.log('[CRM] Post-submit URL:', postSubmitUrl);
    console.log('[CRM] Post-submit title:', postTitle);
    
    // Success if URL changed from /new to a lead UUID or leads list
    const urlChanged = !postSubmitUrl.endsWith('/new') && !postSubmitUrl.endsWith('/new/');
    const hasError = postBodyText.includes('is a required field') ||
                     postBodyText.includes('invalid phone') ||
                     postBodyText.includes('client is a required') ||
                     postBodyText.includes('subject is a required');
    
    console.log('[CRM] URL changed from /new:', urlChanged);
    console.log('[CRM] Has error on page:', hasError);
    console.log('[CRM] Post body sample:', postBodyText.substring(0, 150).replace(/\n/g, ' '));
    
    if (hasError) {
      throw new Error('Form has validation errors: ' + postBodyText.substring(0, 200));
    }
    
    if (!urlChanged) {
      console.warn('[CRM] URL did not change — form may not have submitted');
    }
    
    if (!hasError) {
      try {
        console.log('[CRM] Validating lead creation in CRM list view...');
        await page.goto('https://www.refrens.com/app/relivecure/leads', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        
        const phoneSuffix = cleanPhone.slice(-6);
        const pageTextValidation = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ''));
        const isFound = pageTextValidation.includes(phoneSuffix);
        
        if (isFound) {
          console.log(`[CRM] Successfully pushed: ${lead.phone_number} (Validation SUCCESS)`);
          return { success: true, validated: true, id: lead.id, selectedOrg: orgValue };
        } else {
          console.warn(`[CRM] Validation WARNING: Could not find phone suffix ${phoneSuffix} in leads list`);
          return { success: true, validated: false, id: lead.id, selectedOrg: orgValue };
        }
      } catch (e) {
        console.warn(`[CRM] Validation check failed to execute safely:`, e.message);
        return { success: true, validated: false, id: lead.id, selectedOrg: orgValue };
      }
    }

    return { success: false, id: lead.id, selectedOrg: orgValue };

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