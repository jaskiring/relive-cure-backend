import puppeteer from 'puppeteer';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';
import PQueue from 'p-queue';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = process.env.PUPPETEER_SESSION_DIR || "./puppeteer-session";

const queue = new PQueue({
  concurrency: 2,       // max 2 CRM pushes in parallel (bulk mode)
  intervalCap: 4,       // max 4 tasks per interval
  interval: 10000       // per 10s
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
  if (browserInstancePromise) {
    try {
      const browser = await browserInstancePromise;
      if (browser.isConnected()) {
        return browser;
      }
      console.warn("[CRM] Browser disconnected. Re-launching...");
      browserInstancePromise = null;
    } catch (e) {
      console.warn("[CRM] Browser health check failed. Re-launching...");
      browserInstancePromise = null;
    }
  }

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
          "--memory-pressure-off", "--js-flags=--max-old-space-size=256",
          "--start-maximized"
        ],
        timeout: 60000
      });
    })();
  }
  return browserInstancePromise;
}

const SEL = {
  contactName:  'input[name="contact.name"]',
  contactPhone: 'input[name="contact.phone"]',
  customerCity: 'input[name="customer.city"]',
  subject:      'input[name="subject"]',
  details:      'textarea[name="details"]',
  submit:       'button[type="submit"]',
  stageHidden:  'input[name="privateFields.vendor.stage"]',
  pipeHidden:   'input[name="privateFields.vendor.pipeline"]',
};

// ── Stage IDs from Refrens React fiber (probed 2026-05) ──────────────────────
const STAGE_ID_MAP = {
  'Open':            '69327a85deda46d7a42eba0d',  // Default — new/warm leads
  'Contacted':       '69327a85deda46d7a42eba0e',
  'Proposal Sent':   '69327a85deda46d7a42eba0f',
  'Deal Done':       '69327a85deda46d7a42eba10',
  'Lost':            '69327a85deda46d7a42eba11',  // Cold/closed leads
  'Not Serviceable': '69327a85deda46d7a42eba12',
};
const PIPELINE_NEW_LEADS = '69327a85deda46d7a42eba0c';

async function fillField(page, selector, value) {
  if (!value && value !== 0) return false;
  try {
    await page.waitForSelector(selector, { timeout: 3000 });
    // Clear existing value first (native setter triggers React's clearing)
    await page.$eval(selector, el => {
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Type the new value — delay:0 is fast but still fires proper key events React listens to
    await page.type(selector, String(value), { delay: 0 });
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
  if (lvl === "COLD") return "Lost";   // Cold = won't convert soon
  return "Open";                        // HOT / WARM / unknown → Open (default, needs active work)
}

// ── Set a disco-select value via React fiber (bypasses DOM options not rendering) ──
async function setDiscoSelectByIndex(page, controlIndex, value, label) {
  try {
    const result = await page.evaluate((idx, val, lbl) => {
      const controls = Array.from(document.querySelectorAll('.disco-select__control'));
      const el = controls[idx];
      if (!el) return { ok: false, reason: 'control not found at index ' + idx };
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fiberKey) return { ok: false, reason: 'no react fiber' };
      let fiber = el[fiberKey];
      for (let i = 0; i < 30; i++) {
        if (!fiber) break;
        const onChange = fiber.memoizedProps?.onChange || fiber.memoizedProps?.selectProps?.onChange;
        if (onChange) {
          onChange({ label: lbl, value: val });
          return { ok: true };
        }
        fiber = fiber.return;
      }
      return { ok: false, reason: 'onChange not found in fiber tree' };
    }, controlIndex, value, label);
    if (result.ok) {
      console.log(`[CRM] disco-select[${controlIndex}] set to "${label}" via fiber ✅`);
    } else {
      console.warn(`[CRM] disco-select[${controlIndex}] fiber set failed: ${result.reason}`);
    }
    return result.ok;
  } catch (e) {
    console.warn(`[CRM] setDiscoSelectByIndex error:`, e.message);
    return false;
  }
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

// ─── Auto-login to Refrens when the session has expired ──────────────────────
// Returns true if the page is currently on a Refrens login screen and we
// successfully logged in (caller should re-navigate to the original target).
// Returns false if the page is NOT on a login screen (caller continues as-is).
// Throws if we detect login required but credentials are missing or login fails.
async function ensureRefrensSession(page) {
  const isLogin = await page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    if (/401|sign in|log in|login to refrens/i.test(title)) return true;
    if (/\/signin\b|\/login\b|\/sign-in\b/i.test(location.pathname)) return true;
    // Heuristic — page has an email + password input and ~no other form fields
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.type !== 'hidden');
    const hasEmail = inputs.some(i => i.type === 'email' || /email/i.test(i.name || i.placeholder || ''));
    const hasPwd   = inputs.some(i => i.type === 'password');
    return hasEmail && hasPwd && inputs.length <= 4;
  });
  if (!isLogin) return false;

  const email = process.env.REFRENS_EMAIL;
  const password = process.env.REFRENS_PASSWORD;
  if (!email || !password) {
    throw new Error('Refrens session expired and REFRENS_EMAIL / REFRENS_PASSWORD env vars not set in Railway. Add them and redeploy — the bot will auto-login on the next push.');
  }

  console.log(`[CRM AUTH] Session expired — logging in as ${email}`);

  // Find the email + password inputs and the submit button
  const filled = await page.evaluate((creds) => {
    const setNative = (el, val) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll('input'));
    const emailInput = inputs.find(i => i.type === 'email' || /email/i.test(i.name || i.placeholder || ''));
    const passInput  = inputs.find(i => i.type === 'password');
    if (!emailInput || !passInput) return { ok: false, reason: 'inputs_not_found' };
    setNative(emailInput, creds.email);
    setNative(passInput, creds.password);
    return { ok: true };
  }, { email, password });
  if (!filled.ok) throw new Error(`Refrens login: ${filled.reason}`);

  // Click the submit button (look for a button labelled Login/Sign in or just type="submit")
  await Promise.all([
    page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }).catch(() => {}),
    page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button,input[type="submit"]'));
      const submit = btns.find(b => /sign in|log in|login|submit/i.test(b.textContent || b.value || ''))
                  || document.querySelector('button[type="submit"]')
                  || document.querySelector('input[type="submit"]');
      if (submit) submit.click();
    })
  ]);
  await new Promise(r => setTimeout(r, 1500));

  // Verify login succeeded
  const stillLogin = await page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    return /401|sign in|log in|login/i.test(title) || /\/signin\b|\/login\b/i.test(location.pathname);
  });
  if (stillLogin) {
    // Capture what's on the page so we can tell whether it's bad creds, MFA,
    // SSO-only, or a different login flow.
    const diag = await page.evaluate(() => {
      const visibleErrs = [];
      document.querySelectorAll('[class*="error"],[class*="invalid"],[role="alert"],[class*="toast"],[class*="alert"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const t = (el.innerText || '').trim();
        if (t && t.length < 200) visibleErrs.push(t);
      });
      const visibleButtons = Array.from(document.querySelectorAll('button,a[role="button"]'))
        .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(b => (b.innerText || '').trim())
        .filter(t => t && t.length < 60)
        .slice(0, 12);
      const otpLikely = /otp|verification code|2fa|two.?factor|verify your|6.digit/i.test(document.body.innerText || '');
      const ssoLikely = /continue with google|sign in with google|google|microsoft|sso/i.test(document.body.innerText || '');
      const hasOtpInput = !!document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="code" i]');
      return {
        url: location.href,
        title: document.title,
        visibleErrs: visibleErrs.slice(0, 5),
        visibleButtons,
        otpLikely,
        ssoLikely,
        hasOtpInput,
        bodySnippet: (document.body.innerText || '').slice(0, 400)
      };
    });
    console.error('[CRM AUTH] Login failed — diagnostic:', JSON.stringify(diag, null, 2));
    const reason = diag.hasOtpInput ? 'OTP/MFA prompt — Refrens is asking for a verification code (check email or auth app)'
                 : diag.otpLikely   ? 'MFA likely — page mentions OTP / verification code'
                 : diag.ssoLikely && diag.visibleButtons.some(b => /google|microsoft|sso/i.test(b)) ? 'Refrens may require SSO — visible buttons: ' + diag.visibleButtons.join(' | ')
                 : diag.visibleErrs.length > 0 ? 'Refrens rejected: ' + diag.visibleErrs.join(' | ')
                 : 'Stayed on login screen — buttons visible: ' + diag.visibleButtons.join(' | ');
    throw new Error('Refrens auto-login failed: ' + reason);
  }

  console.log('[CRM AUTH] ✅ Logged in successfully');
  return true;
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

// ─── Diagnostic: dump the structure of the new-lead form ─────────────────────
// Opens /leads/new (re-uses the existing puppeteer session that already has
// Refrens cookies), waits for the form to render, then returns a structural
// dump: every disco-select with its current value/placeholder/required-marker,
// every input/textarea, and the visible labels. Used to figure out what the
// form looks like right now without driving it manually.
export async function dumpCrmNewLeadForm() {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto('https://www.refrens.com/app/relivecure/leads/new', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    // Auto-login if redirected to /signin
    const reAuthed = await ensureRefrensSession(page);
    if (reAuthed) {
      await page.goto('https://www.refrens.com/app/relivecure/leads/new', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
    }
    // Let React hydrate
    await new Promise(r => setTimeout(r, 4000));

    const dump = await page.evaluate(() => {
      const txt = el => (el?.innerText || el?.textContent || '').trim().slice(0, 80);
      // Every disco-select control with index, current value, and its closest label
      const selects = Array.from(document.querySelectorAll('.disco-select__control')).map((c, i) => {
        // Closest label = nearest preceding label/heading text within ~4 parents
        let label = '';
        let cur = c;
        for (let d = 0; d < 5 && cur; d++) {
          cur = cur.parentElement;
          if (!cur) break;
          const lbl = cur.querySelector('label,h4,h5,h6,.form-label,[class*="label"]');
          if (lbl && lbl !== c && txt(lbl)) { label = txt(lbl); break; }
        }
        // Also try parent's text before the dropdown
        if (!label && c.parentElement) {
          const sib = c.parentElement.previousElementSibling;
          if (sib) label = txt(sib);
        }
        return {
          index: i,
          label: label || '(no label)',
          currentValue: c.querySelector('.disco-select__single-value')?.innerText?.trim() || '',
          placeholder: c.querySelector('.disco-select__placeholder')?.innerText?.trim() || '',
          isMulti: c.classList.contains('disco-select__control--is-multi') || !!c.querySelector('.disco-select__multi-value'),
          isFocused: c.classList.contains('disco-select__control--is-focused'),
          hasError: !!c.closest('[class*="error"],[class*="invalid"]'),
          requiredMarker: !!(c.closest('div')?.querySelector('[class*="required"],span.text-danger,span.required'))
        };
      });

      // Visible inputs + textareas
      const inputs = Array.from(document.querySelectorAll('input,textarea')).map((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        if (el.type === 'hidden') return null;
        // Closest label
        let label = '';
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) label = txt(lbl);
        }
        if (!label) {
          const parentLabel = el.closest('label');
          if (parentLabel) label = txt(parentLabel);
        }
        return {
          index: i,
          tag: el.tagName,
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          value: (el.value || '').slice(0, 40),
          required: el.required || el.getAttribute('aria-required') === 'true',
          label: label || '(no label)'
        };
      }).filter(Boolean);

      // Any visible elements marked required or with asterisks
      const requiredLabels = [];
      document.querySelectorAll('label,h4,h5,h6,span').forEach(el => {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 80) return;
        if (/\*\s*$|required/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) requiredLabels.push(t.slice(0, 80));
        }
      });

      // URL + page title
      return {
        url: location.href,
        title: document.title,
        bodyChars: (document.body.innerText || '').length,
        selectsCount: selects.length,
        inputsCount: inputs.length,
        selects,
        inputs: inputs.slice(0, 30),
        requiredLabels: [...new Set(requiredLabels)].slice(0, 20),
        // First 500 chars of any visible form errors
        formErrors: Array.from(document.querySelectorAll('[class*="error"],[class*="invalid"],[role="alert"]'))
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => (el.innerText || '').trim())
          .filter(t => t && t.length < 200)
          .slice(0, 10)
      };
    });

    return dump;
  } finally {
    await context.close();
  }
}

async function processLead(lead) {
  const t_open = Date.now();
  console.log(`[CRM] Starting push for lead_id=${lead.id || 'new'}, phone=${lead.phone_number}`);
  if (!lead.id) lead.id = crypto.randomUUID();

  const realName = (lead.contact_name || lead.name || '').trim()
    .replace(/^(WhatsApp Lead|Session Test)$/i, '').trim()
    || `Lead-${(lead.phone_number || '').slice(-4)}`;

  const cleanPhone = (lead.phone_number || '')
    .replace(/^\+91/, '').replace(/^91(?=\d{10})/, '').trim();

  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    // ── 1. Auth: inject cookies + wait for __at token ───────────────────────
    const cookies = parseCookies(process.env.REFRENS_COOKIES);
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));
    }
    const tokenReady = await waitForTokenRefresh(page, 12000);
    if (!tokenReady) throw new Error('__rt exchange failed or timed out');

    const capturedToken = await page.evaluate(() => sessionStorage.getItem('__at'));
    await page.evaluateOnNewDocument((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);

    // ── 2. Load the Add New Lead form ────────────────────────────────────────
    await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Refrens may have redirected us to /signin if the session expired.
    // ensureRefrensSession() detects that and logs back in using REFRENS_EMAIL
    // / REFRENS_PASSWORD env vars, then we re-navigate to the new-lead form.
    const reAuthed = await ensureRefrensSession(page);
    if (reAuthed) {
      console.log('[CRM] Re-authenticated — re-navigating to new-lead form');
      await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    await page.evaluate((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);
    await page.waitForSelector('.disco-select__control', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500)); // let React hydrate

    // ── 3. Prospect Organisation (REQUIRED by Refrens) ──────────────────────────
    // On Railway (fresh browser session) the org dropdown is async-search:
    // clicking it sometimes returns 0 options until a character is typed to
    // trigger the search. Production logs proved this — May 23 run got
    // `options available (0)` and submit failed with required-field error.
    //
    // Resilient flow:
    //   1) read current value; if non-empty, skip
    //   2) click to open
    //   3) try options() — if >=1 option, pick it
    //   4) if 0 options, type "rel" into the dropdown's own input to trigger
    //      async search, wait up to 4s for options to appear, pick first
    //   5) if still 0, type "a" (broadest match), wait, pick first
    //   6) if STILL nothing, escape and continue (the assert below will throw
    //      a precise error so the dashboard knows what to retry)
    async function tryOpenAndPick(controlIdx, label) {
      const control = await page.evaluateHandle((idx) => {
        const all = Array.from(document.querySelectorAll('.disco-select__control'));
        return all[idx] || null;
      }, controlIdx);
      const el = control.asElement();
      if (!el) return { picked: null, optionsCount: 0 };

      // Open
      await el.click();
      await new Promise(r => setTimeout(r, 600));

      // First attempt — options may already be there
      let opts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
      );

      // If empty, type "rel" into the actual input to trigger async search
      if (opts.length === 0) {
        const inputHandle = await page.evaluateHandle((idx) => {
          const all = Array.from(document.querySelectorAll('.disco-select__control'));
          return all[idx]?.querySelector('input') || null;
        }, controlIdx);
        const inp = inputHandle.asElement();
        if (inp) {
          await inp.focus();
          await inp.type('rel', { delay: 80 });
          // Wait for async options
          try {
            await page.waitForFunction(
              () => document.querySelectorAll('.disco-select__option').length > 0,
              { timeout: 4000 }
            );
          } catch(_) {}
          opts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
          );
        }
      }

      // If still empty, try a broader char
      if (opts.length === 0) {
        const inputHandle = await page.evaluateHandle((idx) => {
          const all = Array.from(document.querySelectorAll('.disco-select__control'));
          return all[idx]?.querySelector('input') || null;
        }, controlIdx);
        const inp = inputHandle.asElement();
        if (inp) {
          // Clear and try "a" (matches almost any org/name)
          await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await inp.type('a', { delay: 80 });
          try {
            await page.waitForFunction(
              () => document.querySelectorAll('.disco-select__option').length > 0,
              { timeout: 4000 }
            );
          } catch(_) {}
          opts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
          );
        }
      }

      console.log(`[${label}] options available (${opts.length}): ${opts.slice(0, 5).join(' | ')}`);

      const picked = await page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('.disco-select__option'));
        const match = options.find(o => o.innerText.toLowerCase().includes('relive')) || options[0];
        if (match) { match.click(); return match.innerText.trim(); }
        return null;
      });
      if (!picked) await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 400));
      return { picked, optionsCount: opts.length };
    }

    try {
      const controls = await page.$$('.disco-select__control');
      console.log(`[ORG] ${controls.length} disco-select controls`);

      const alreadySelected = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll('.disco-select__control'));
        return controls.length >= 2
          ? (controls[1].querySelector('.disco-select__single-value')?.innerText?.trim() || '')
          : '';
      });
      console.log(`[ORG] current value: "${alreadySelected}"`);

      if (!alreadySelected && controls.length >= 2) {
        const r = await tryOpenAndPick(1, 'ORG');
        console.log(`[ORG] clicked: "${r.picked}"`);

        // Fallback: if index-1 truly has no options, scan EVERY empty disco-select
        // and try the same flow — Refrens may have reordered the form.
        if (!r.picked) {
          console.warn('[ORG] index-1 dropdown empty after typing — scanning all controls');
          const emptyIdxs = await page.evaluate(() => {
            const ctrls = Array.from(document.querySelectorAll('.disco-select__control'));
            const out = [];
            ctrls.forEach((c, i) => {
              const v = c.querySelector('.disco-select__single-value')?.innerText?.trim() || '';
              if (!v) out.push(i);
            });
            return out;
          });
          console.log(`[ORG] empty dropdown indexes: ${JSON.stringify(emptyIdxs)}`);
          for (const idx of emptyIdxs) {
            if (idx === 1 || idx === 3) continue; // 1 already tried, 3 is stage (handled below)
            const r2 = await tryOpenAndPick(idx, `ORG-FALLBACK[${idx}]`);
            console.log(`[ORG-FALLBACK[${idx}]] clicked: "${r2.picked}"`);
            if (r2.picked) break;
          }
        }
      }
    } catch (e) {
      console.warn(`[ORG] error: ${e.message}`);
    }

    const t_fill = Date.now();

    // ── 4. Stage (disco-select[3]) — set via React fiber ─────────────────────
    // The stage dropdown options don't render in headless DOM but ARE in React state.
    // We bypass the DOM and call the React Select onChange handler directly.
    const stageLabel = getStage(lead.intent_level);
    const stageId    = STAGE_ID_MAP[stageLabel] || STAGE_ID_MAP['Open'];
    const stageSet   = await setDiscoSelectByIndex(page, 3, stageId, stageLabel);
    if (!stageSet) {
      // Fallback: leave as default "Open" — do NOT throw, just warn
      console.warn('[CRM] Stage fiber set failed — leaving default "Open"');
    }
    await new Promise(r => setTimeout(r, 300));

    // ── 5. Expand Lead Details (needed for subject/details fields) ───────────
    // Check if subject is already visible; if not, find and click the accordion
    const subjectAlreadyVisible = await page.evaluate(() => {
      const el = document.querySelector('input[name="subject"]');
      return el ? el.offsetParent !== null : false;
    });

    if (!subjectAlreadyVisible) {
      const expandResult = await page.evaluate(() => {
        // Strategy A: find exact text "Lead Details" leaf node and click its closest section/parent
        const all = Array.from(document.querySelectorAll('*'));
        const heading = all.find(el => {
          const t = (el.innerText || '').trim();
          return (t === 'Lead Details' || t === 'Lead Details *') && el.children.length <= 3;
        });
        if (heading) {
          // Walk up to find the clickable accordion trigger
          let node = heading;
          for (let i = 0; i < 5; i++) {
            if (!node) break;
            const cls = (node.className || '').toLowerCase();
            if (cls.includes('accordion') || cls.includes('collapsible') || cls.includes('section') || cls.includes('panel') || cls.includes('header')) {
              node.click();
              return 'clicked ancestor: ' + node.className.substring(0, 60);
            }
            node = node.parentElement;
          }
          // Fallback: just click the heading itself
          heading.click();
          return 'clicked heading: ' + heading.tagName;
        }
        return 'not found';
      });
      console.log('[CRM] Lead Details expand attempt:', expandResult);

      // Wait until subject input becomes visible (up to 4s)
      await page.waitForFunction(
        () => {
          const el = document.querySelector('input[name="subject"]');
          return el && el.offsetParent !== null;
        },
        { timeout: 4000 }
      ).catch(() => {
        console.warn('[CRM] ⚠️ subject input still not visible after expand — will try scrolling');
      });

      // Scroll the subject field into view regardless
      await page.evaluate(() => {
        const el = document.querySelector('input[name="subject"]');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      });
      await new Promise(r => setTimeout(r, 400));
    } else {
      console.log('[CRM] Lead Details already expanded ✅');
    }

    // ── 6. Fill contact text fields ──────────────────────────────────────────
    await fillField(page, SEL.contactName, realName);
    await fillField(page, SEL.contactPhone, cleanPhone);
    await fillField(page, SEL.customerCity, lead.city || 'Delhi');

    // ── 7. Lead Subject ───────────────────────────────────────────────────────
    // IMPORTANT: subject is REQUIRED by Refrens. On Railway (no saved session),
    // the Lead Details accordion may be collapsed so page.type() fails silently.
    // Use $eval + React native value setter — works on hidden inputs in the DOM.
    const isTest = !!(lead.is_test || (lead.contact_name || '').toUpperCase().includes('TEST'));
    const intentTag = (lead.intent_level || 'WARM').toUpperCase();
    const subjectPrefix = isTest ? '[TEST] ' : '';
    const subject = `${subjectPrefix}[${intentTag}] LASIK Lead — ${realName} (${cleanPhone})`;

    const subjectResult = await page.$eval(SEL.subject, (el, val) => {
      el.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (proto && proto.set) proto.set.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    }, subject).catch(() => null);

    if (!subjectResult) {
      // Element may not be in DOM at all — last resort: try visible-path fill
      await fillField(page, SEL.subject, subject);
      console.warn('[CRM] Subject $eval failed — fell back to fillField');
    } else {
      console.log(`[CRM] Subject set via $eval ✅ ("${subjectResult.substring(0, 50)}")`);
    }

    // ── 8. Additional Description — ALL lead data packed here ────────────────
    // This is the primary data carrier for analytics and Refrens team visibility
    const notes = [
      `LEAD DETAILS`,
      `------------------------------`,
      `Name:          ${realName}`,
      `Phone:         ${cleanPhone}`,
      `City:          ${lead.city || 'N/A'}`,
      `Surgery City:  ${lead.preferred_surgery_city || lead.city || 'N/A'}`,
      ``,
      `Intent:        ${(lead.intent_level || 'N/A').toUpperCase()}`,
      `Intent Score:  ${lead.intent_score || 'N/A'}`,
      `Timeline:      ${lead.timeline || 'N/A'}`,
      `Insurance:     ${lead.insurance || 'N/A'}`,
      `Wants Call:    ${lead.request_call ? 'YES' : 'No'}`,
      `Urgency:       ${lead.urgency_level || 'N/A'}`,
      ``,
      `Assignee:      ${lead.assignee || 'Unassigned'}`,
      `Source:        ${lead.source || 'whatsapp_bot'}`,
      `Params Done:   ${lead.parameters_completed || 0}/4`,
      ``,
      `Last Message:  ${(lead.last_user_message || 'N/A').substring(0, 200)}`,
      lead.remarks ? `Remarks:       ${lead.remarks}` : '',
    ].filter(Boolean).join('\n');
    // For the large notes textarea: native setter is instant vs page.type()'s per-char CDP calls
    try {
      await page.waitForSelector(SEL.details, { timeout: 3000 });
      await page.$eval(SEL.details, (el, val) => {
        el.focus();
        const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (proto && proto.set) proto.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, notes);
    } catch(e) {
      console.warn('[CRM] Details textarea fill fallback:', e.message);
      await fillField(page, SEL.details, notes);
    }

    await new Promise(r => setTimeout(r, 300));

    // ── 9. Assert critical fields before submit ───────────────────────────────
    await assertValue(page, SEL.contactName, realName);
    await assertValue(page, SEL.contactPhone, cleanPhone);

    const t_submit = Date.now();

    // ── 10. Scroll to submit button and click ─────────────────────────────────
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise(r => setTimeout(r, 400));

    // Debug: log field values just before submit
    const preSubmitCheck = await page.evaluate((sels) => ({
      name:    document.querySelector(sels.contactName)?.value || '(empty)',
      phone:   document.querySelector(sels.contactPhone)?.value || '(empty)',
      subject: document.querySelector(sels.subject)?.value || '(empty)',
    }), SEL);
    console.log(`[CRM] Pre-submit values: name="${preSubmitCheck.name}" phone="${preSubmitCheck.phone}" subject="${preSubmitCheck.subject.substring(0,40)}"`);

    // Screenshot before submit (saved to /tmp for Railway debugging)
    try {
      await page.screenshot({ path: `/tmp/crm-presubmit-${lead.id}.png`, fullPage: false });
    } catch(_) {}

    // Hook into client-side toast/error layers BEFORE clicking submit so we
    // capture the first error/toast Refrens emits (some are transient and
    // disappear within ~2s, which is why the previous post-click scan saw
    // a clean page and threw the generic "URL did not change" error).
    await page.evaluate(() => {
      window.__crm_errs__ = [];
      // Capture any text node added to the DOM that looks like an error/toast.
      const obs = new MutationObserver(muts => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!n || n.nodeType !== 1) continue;
            const t = (n.innerText || n.textContent || '').trim();
            if (!t || t.length > 300) continue;
            if (/required|invalid|already exist|duplicate|please|error|cannot|must be|enter a valid|incorrect/i.test(t)) {
              window.__crm_errs__.push(t.slice(0, 200));
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      // Also tee console.error
      const origErr = console.error;
      console.error = function(...args) {
        try { window.__crm_errs__.push('[console.error] ' + args.map(a => String(a)).join(' ').slice(0, 200)); } catch(_) {}
        return origErr.apply(this, args);
      };
    });

    await Promise.all([
      page.waitForNavigation({ timeout: 18000 }).catch(() => {}),
      page.click(SEL.submit)
    ]);

    // After clicking, wait a beat — Refrens may run async client-side validation
    // (e.g. dedup check, phone format) before either showing an error or routing.
    await new Promise(r => setTimeout(r, 1500));

    // ── 11. Validate success (URL should change from /new) ────────────────────
    let postUrl = page.url();
    let urlChanged = !postUrl.endsWith('/new') && !postUrl.endsWith('/new/');

    // Second-chance: some Refrens deploys finish async, so give it one more
    // 4-second window before giving up.
    if (!urlChanged) {
      try {
        await page.waitForFunction(
          () => !location.href.endsWith('/new') && !location.href.endsWith('/new/'),
          { timeout: 4000 }
        );
        postUrl = page.url();
        urlChanged = !postUrl.endsWith('/new') && !postUrl.endsWith('/new/');
      } catch(_) {}
    }

    if (!urlChanged) {
      // Pull the captured client-side errors + a broader body scan.
      const diag = await page.evaluate(() => {
        const errs = (window.__crm_errs__ || []).slice(-8);
        // Look for visible error/toast/alert spans on the page right now
        // Tight filter — skip breadcrumbs / URLs / nav elements that happen to
        // match a class containing "error" (e.g. "errorBoundary" wrappers).
        const visibleErrs = [];
        const candidates = document.querySelectorAll(
          '[class*="error"],[class*="Error"],[class*="invalid"],[class*="toast"],[class*="alert"],[role="alert"],[class*="helper-text"],[class*="ant-form-item-explain"]'
        );
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Skip the breadcrumb / nav / link-shaped text — only keep real validation messages
          if (el.closest('nav,header,a,[role="navigation"],[class*="breadcrumb"]')) continue;
          const t = (el.innerText || el.textContent || '').trim();
          if (!t || t.length > 200 || /^\s*$/.test(t)) continue;
          if (/^\/?[a-z0-9_-]+\//i.test(t)) continue;        // looks like a URL path
          if (/^https?:\/\//i.test(t)) continue;             // is a URL
          if (t.length < 4) continue;                        // too short to be useful
          visibleErrs.push(t);
          if (visibleErrs.length >= 10) break;
        }
        return {
          errs,
          visibleErrs,
          bodyHas: {
            required: /required/i.test(document.body.innerText),
            invalid:  /invalid/i.test(document.body.innerText),
            duplicate:/already exist|duplicate/i.test(document.body.innerText),
            phone:    /phone|mobile/i.test(document.body.innerText) && /invalid|incorrect|format/i.test(document.body.innerText)
          },
          url: location.href
        };
      });

      console.error(`[CRM] Submit failed — diagnostic:`, JSON.stringify(diag));
      try {
        await page.screenshot({ path: `/tmp/crm-submit-fail-${lead.id}.png`, fullPage: true });
      } catch(_) {}

      // Build a precise error message so the queue's retry logic + the dashboard
      // know whether this is a transient issue worth retrying or a hard reject.
      const surfaced = [...(diag.visibleErrs || []), ...(diag.errs || [])].slice(0, 3).join(' | ').slice(0, 300);
      if (diag.bodyHas.duplicate) {
        throw new Error(`Refrens rejected: duplicate lead${surfaced ? ' — ' + surfaced : ''}`);
      }
      if (diag.bodyHas.phone) {
        throw new Error(`Refrens rejected: phone format invalid (phone="${preSubmitCheck.phone}")${surfaced ? ' — ' + surfaced : ''}`);
      }
      if (diag.bodyHas.required) {
        throw new Error(`Refrens rejected: required field missing${surfaced ? ' — ' + surfaced : ''}`);
      }
      if (surfaced) {
        throw new Error(`Refrens rejected submit: ${surfaced}`);
      }
      throw new Error('Submit clicked but URL did not change — no visible error captured. Likely Refrens changed validation rules silently. See /tmp/crm-submit-fail-' + lead.id + '.png on Railway.');
    }

    const t_done = Date.now();
    console.log(`[CRM] ✅ lead_id=${lead.id} name="${realName}" stage="${stageLabel}" | t_open=${t_fill - t_open}ms t_fill=${t_submit - t_fill}ms t_submit=${t_done - t_submit}ms total=${t_done - t_open}ms`);

    return { success: true, id: lead.id };

  } catch (error) {
    console.error(`[CRM ERROR] lead_id=${lead.id}:`, error.message);
    // Save debug screenshot to help diagnose headless failures
    try {
      const screenshotPath = `/tmp/crm-error-${lead.id}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[CRM] Error screenshot saved: ${screenshotPath}`);
    } catch (ssErr) {
      // ignore screenshot failure
    }
    throw error;
  } finally {
    await context.close();
  }
}

export async function processQueue(leads, concurrencyLimit = 2) {
  const results = [];
  queue.concurrency = concurrencyLimit;
  
  for (const lead of leads) {
    console.log(`[QUEUE] Queueing lead ${lead.id}. pending=${queue.pending} size=${queue.size}`);
    const promise = queue.add(async () => {
      const start = Date.now();
      try {
        return await withTimeout(processLead(lead), 90000);
      } catch (err) {
        const elapsed = Date.now() - start;
        if (err.message === 'Timeout') {
          console.error(`[CRM_TIMEOUT] lead_id=${lead.id} elapsed=${elapsed}ms`);
        } else {
          console.error(`[QUEUE] Lead ${lead.id} failed: ${err.message}`);
        }
        return { success: false, id: lead.id, error: err.message };
      }
    });
    results.push(promise);
  }

  return Promise.all(results);
}

export const pushToCRM = processLead;

// Export shared browser instance so refrens-sync can reuse it (same userDataDir profile)
export async function getBrowserInstance() { return getBrowser(); }