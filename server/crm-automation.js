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

// ── F4: Set a React-controlled input — minimal, MCP-verified approach ─────────
// Proven via MCP-in-Chrome on the live Refrens form: native setter + a single
// "input" event is sufficient to update React state for both the regular
// inputs (name, city, subject) AND the phone-input library. The previous
// fiber-walk + onChange-double-fire actually BROKE the phone-input by
// invoking the parent form's onChange with a stale target, causing React
// to clear the phone value.
async function setReactInputValue(page, selector, value) {
  try {
    await page.waitForSelector(selector, { timeout: 3000 });
    const result = await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: 'not_found' };
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, value: el.value };
    }, selector, String(value));
    if (!result.ok) console.warn(`[CRM] setReactInputValue ${selector} failed: ${result.reason}`);
    return result.ok;
  } catch (e) {
    console.warn(`[CRM] setReactInputValue ${selector} error: ${e.message}`);
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
    // ── Mirror the working refrens-sync.js auth flow EXACTLY ────────────────
    // (1) set REFRENS_COOKIES BEFORE any navigation
    const cookiesRaw = process.env.REFRENS_COOKIES;
    if (cookiesRaw) {
      try {
        const cookies = JSON.parse(cookiesRaw);
        await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));
      } catch (e) {
        console.warn('[DIAG] REFRENS_COOKIES parse failed:', e.message);
      }
    }

    // (2) warm /app first to refresh the __at token (same pattern as processLead)
    await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));

    // (3) now navigate to the lead form
    await page.goto('https://www.refrens.com/app/relivecure/leads/new', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    // Let React hydrate
    await new Promise(r => setTimeout(r, 4000));

    // (4) Deep probe of disco-select[1] (Prospect Organisation). The previous
    //     probe showed typing "rel" doesn't produce options. Drill down to see
    //     exactly what's happening: does the input exist? does typing change
    //     its value? are there other related menus rendered? what network
    //     calls fire when we type?
    const networkCalls = [];
    page.on('response', (resp) => {
      const u = resp.url();
      if (u.includes('refrens.com') && (u.includes('organi') || u.includes('search') || u.includes('contact') || u.includes('autocomplete') || u.includes('graphql'))) {
        networkCalls.push({ url: u.slice(0, 160), status: resp.status() });
      }
    });

    const orgProbe = await (async () => {
      const probe = { steps: [] };
      try {
        // Find Prospect Organisation by label (the production code does the same)
        const ctrlHandle = await page.evaluateHandle(() => {
          const all = Array.from(document.querySelectorAll('.disco-select__control'));
          for (const c of all) {
            let cur = c;
            for (let d = 0; d < 6 && cur; d++) {
              cur = cur.parentElement;
              if (!cur) break;
              const lbl = cur.querySelector('label,h4,h5,h6,.form-label,[class*="label"]');
              if (lbl && /prospect\s*organi[sz]ation/i.test(lbl.innerText || lbl.textContent || '')) return c;
            }
          }
          return null;
        });
        const ctrl = ctrlHandle.asElement();
        if (!ctrl) {
          probe.steps.push({ step: 'find', error: 'no dropdown matching Prospect Organisation label' });
          return probe;
        }
        probe.steps.push({ step: 'find', found: true });

        // Step 1 — inspect DOM before click
        probe.steps.push(await ctrl.evaluate(c => {
          const input = c.querySelector('input');
          return {
            step: 'inspect_pre',
            classList: c.className,
            hasInput: !!input,
            inputId: input?.id || null
          };
        }));

        // Open with REAL mouse event at rect center
        const rect = await ctrl.evaluate(c => {
          const r = c.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await ctrl.scrollIntoView();
        await new Promise(r => setTimeout(r, 200));
        await page.mouse.click(rect.x, rect.y);
        await new Promise(r => setTimeout(r, 1200));
        probe.steps.push(await page.evaluate(() => ({
          step: 'after_real_mouse_click',
          optionsCount: document.querySelectorAll('.disco-select__option').length,
          menuExists: !!document.querySelector('.disco-select__menu'),
          firstFewOptions: Array.from(document.querySelectorAll('.disco-select__option')).slice(0, 8).map(o => o.innerText.trim())
        })));

        // If initial open didn't load options, try typing
        const initialCount = await page.evaluate(() => document.querySelectorAll('.disco-select__option').length);
        if (initialCount === 0) {
          const input = await ctrl.evaluateHandle(c => c.querySelector('input'));
          const inpEl = input.asElement();
          if (inpEl) {
            for (const term of ['re', 'rel', 'relive']) {
              await inpEl.focus();
              await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
              await new Promise(r => setTimeout(r, 200));
              await inpEl.type(term, { delay: 120 });
              await new Promise(r => setTimeout(r, 2500));
              const opts = await page.evaluate(() =>
                Array.from(document.querySelectorAll('.disco-select__option')).slice(0, 8).map(o => o.innerText.trim())
              );
              probe.steps.push({ step: `typed_${term}`, optionsCount: opts.length, options: opts });
              if (opts.length > 0) break;
            }
          }
        }
      } catch (e) {
        probe.error = e.message;
      }
      await page.keyboard.press('Escape').catch(() => {});
      probe.networkCalls = networkCalls.slice(0, 20);
      return probe;
    })();

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

    return { ...dump, orgProbe };
  } finally {
    await context.close();
  }
}

// ── Post-create: assign the lead to a teammate via the "Lead assignee" widget ─
// Refrens's new-lead form has no assignee field. After submit lands on the
// lead detail page, this fn:
//   1. Clicks the pencil/edit on the "Lead assignee" widget → modal opens
//   2. Types target name in the search input → filters collaborators
//   3. Walks each radio's ancestors looking for one containing the target
//      name (case-insensitive substring, ancestor inner text < 200 chars to
//      avoid hitting the whole modal). Clicks that row + the radio.
//   4. Clicks "Save Changes" → "Transfer Lead?" confirmation appears
//   5. Clicks "Yes, Transfer Lead" → persists
// Proven via MCP browser: lead 6a11c9d982c97a0012c7c16c successfully
// reassigned from "Relive Cure" → "NISHIKANT".
async function assignLeadToCollaborator(page, assigneeName) {
  if (!assigneeName) return false;

  // Wait for lead detail page to fully load after submit redirect
  try {
    await page.waitForSelector('span', { timeout: 8000 });
    // Give React time to render the full lead detail page
    await new Promise(r => setTimeout(r, 3000));
  } catch(_) {}

  const result = await page.evaluate(async (name) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    // 1. Find "Lead assignee" widget + click edit button
    //    Case-insensitive search — Refrens may capitalize inconsistently
    let labelEl = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      labelEl = Array.from(document.querySelectorAll('span')).find(el => {
        const t = (el.innerText || '').trim().toLowerCase();
        return t === 'lead assignee' || t === 'lead assignee:';
      });
      if (labelEl) break;
      await sleep(2000); // wait for page to render
    }
    if (!labelEl) {
      // Debug: list all span texts to help diagnose
      const allSpans = Array.from(document.querySelectorAll('span'))
        .map(el => (el.innerText || '').trim())
        .filter(t => t.length > 3 && t.length < 60 && /lead|assign|owner/i.test(t));
      return { ok: false, step: 'find_label', reason: 'no Lead assignee label found', debugSpans: allSpans.slice(0, 10), url: location.href };
    }

    // Try the parent element first, then walk up to find the edit button
    let editBtn = labelEl.parentElement?.querySelector('button');
    if (!editBtn) {
      // Walk up 3 levels looking for any edit/pencil button
      let container = labelEl.parentElement;
      for (let i = 0; i < 3 && container && !editBtn; i++) {
        container = container.parentElement;
        if (container) editBtn = container.querySelector('button');
      }
    }
    if (!editBtn) return { ok: false, step: 'find_edit_btn', reason: 'no edit button near Lead assignee label' };
    editBtn.click();
    await sleep(1500);

    // 2. Type name in search input
    const input = document.querySelector('input[name="searchCollaborator"]');
    if (!input) return { ok: false, step: 'search_input_appeared', reason: 'modal may not have opened' };
    input.focus();
    setter.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(2500);

    // 3. For each radio, walk up ancestors looking for one whose innerText
    //    contains the target name (case-insensitive) and is < 200 chars
    //    (so we get the row, not the whole modal).
    const nameLower = name.toLowerCase();
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    let pickedRow = null;
    let pickedRadio = null;
    for (const radio of radios) {
      let cur = radio;
      for (let i = 0; i < 8; i++) {
        cur = cur.parentElement;
        if (!cur) break;
        const t = (cur.innerText || '');
        if (t.length < 200 && t.toLowerCase().includes(nameLower)) {
          pickedRow = cur;
          pickedRadio = radio;
          break;
        }
      }
      if (pickedRow) break;
    }
    if (!pickedRow) return { ok: false, step: 'match_radio', reason: `no row containing "${name}"`, radioCount: radios.length };
    pickedRow.click();
    await sleep(500);
    if (pickedRadio) pickedRadio.click();
    await sleep(500);

    // 4. Click "Save Changes"
    const saveBtn = Array.from(document.querySelectorAll('button')).find(b => /save\s*changes/i.test(b.innerText || ''));
    if (!saveBtn) return { ok: false, step: 'save_btn' };
    saveBtn.click();
    await sleep(2000);

    // 5. Click "Yes, Transfer Lead" confirmation
    const confirmBtn = Array.from(document.querySelectorAll('button')).find(b => /yes,?\s*transfer/i.test(b.innerText || ''));
    if (!confirmBtn) return { ok: false, step: 'confirm_btn', reason: 'no Yes, Transfer Lead button found' };
    confirmBtn.click();
    await sleep(3500);

    // 6. Verify
    const finalLabel = Array.from(document.querySelectorAll('span')).find(el =>
      (el.innerText || '').trim().toLowerCase().startsWith('lead assignee'));
    const finalVal = finalLabel?.parentElement?.querySelector('button span')?.innerText?.trim() || '(?)';
    const matched = finalVal.toLowerCase().includes(nameLower);
    return { ok: matched, step: 'verified', finalAssignee: finalVal };
  }, assigneeName);

  console.log(`[ASSIGN] result:`, JSON.stringify(result));
  return result.ok === true;
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
    // Diagnostics proved (live probe May 23):
    //   - Refrens reorganized the form — the field at index [1] is now
    //     "Prospect Organisation", not the old Sales Rep dropdown
    //   - Synthetic DOM .click() does NOT open the dropdown reliably
    //   - The dropdown DOES contain prospects (Relive cure, etc.) on the real
    //     UI, but the puppeteer search returns "No Prospect Found" if the
    //     dropdown's data hasn't loaded
    //   - The cure: open via real mouse events (page.mouse) at the bounding-
    //     rect center, wait for the menu to render, then progressively type
    //     "re" → "rel" → backspace → "rel" until "Relive cure" appears
    //
    // Find dropdowns by their LABEL instead of positional index so future
    // Refrens reorders don't break us again.
    async function findDiscoSelectByLabel(labelRegex) {
      return await page.evaluateHandle((reSrc) => {
        const re = new RegExp(reSrc, 'i');
        const all = Array.from(document.querySelectorAll('.disco-select__control'));
        for (const c of all) {
          // Walk up to ~5 parents looking for a label/heading text that matches
          let cur = c;
          for (let d = 0; d < 6 && cur; d++) {
            cur = cur.parentElement;
            if (!cur) break;
            const lbl = cur.querySelector('label,h4,h5,h6,.form-label,[class*="label"]');
            if (lbl && re.test(lbl.innerText || lbl.textContent || '')) return c;
          }
        }
        return null;
      }, labelRegex.source || labelRegex);
    }

    async function pickProspectOrganisation() {
      const ctrlHandle = await findDiscoSelectByLabel(/prospect\s*organi[sz]ation/);
      const ctrl = ctrlHandle.asElement();
      if (!ctrl) {
        console.warn('[ORG] Prospect Organisation dropdown not found by label');
        return { picked: null, reason: 'no_dropdown' };
      }

      // Already filled? skip.
      const existing = await ctrl.evaluate(c => c.querySelector('.disco-select__single-value')?.innerText?.trim() || '');
      if (existing) {
        console.log(`[ORG] current value: "${existing}" — leaving as-is`);
        return { picked: existing, reason: 'already_filled' };
      }

      // Get the React-Select hidden input element.
      // IMPORTANT: React-Select's input has width:1px when unfocused, so
      // page.mouse.click() on its bounding rect misses it. Use
      // ElementHandle.focus() which calls element.focus() directly — works
      // regardless of visual dimensions.
      const inpHandle = await ctrl.evaluateHandle(c => c.querySelector('input'));
      const inpEl = inpHandle.asElement();
      if (!inpEl) return { picked: null, reason: 'no_input' };

      // Scroll the control into view, then open menu with a real mouse click.
      // inpEl.focus() does NOT open the React-Select menu — only mousedown does.
      // Without the menu open, loadOptions never fires and the API is never called.
      await ctrl.evaluate(c => c.scrollIntoView({ behavior: 'instant', block: 'center' }));
      await new Promise(r => setTimeout(r, 200));
      const ctrlRect = await ctrl.evaluate(c => {
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(ctrlRect.x, ctrlRect.y);
      await new Promise(r => setTimeout(r, 600));

      // Check if options loaded on focus alone (Refrens sometimes loads all)
      const initialOpts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
      );
      console.log(`[ORG] after focus: ${initialOpts.length} options${initialOpts.length ? ': ' + initialOpts.slice(0, 5).join(' | ') : ''}`);

      let pickedNow = await tryClickReliveMatch();
      if (pickedNow) return { picked: pickedNow, reason: 'open_only' };

      // No match yet — progressively type to trigger the async search.
      // Probe confirmed: 're' → 0 opts, 'rel' → 1 opt ("Relive cure").
      for (const term of ['re', 'rel', 'reli', 'relive']) {
        // Re-focus input, clear with Ctrl+A → Backspace, then type
        await inpEl.focus();
        await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 200));

        // ElementHandle.type() ensures focus before each keystroke
        await inpEl.type(term, { delay: 100 });
        try {
          await page.waitForFunction(
            () => document.querySelectorAll('.disco-select__option').length > 0,
            { timeout: 4000 }
          );
        } catch(_) {}
        const opts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
        );
        console.log(`[ORG] typed "${term}" → ${opts.length} options: ${opts.slice(0, 5).join(' | ')}`);

        pickedNow = await tryClickReliveMatch();
        if (pickedNow) return { picked: pickedNow, reason: `search:${term}` };
      }

      // ── Last resort per user instruction ──────────────────────────────────
      // "try relive cure first if can't find it then add any other after
      //  removing everything from the field, find anything else in the
      //  dropdown and add that"
      // → Clear the input fully so the dropdown shows the FULL prospect list
      //   (currently it's filtered to "relive" which returned 0 in the search
      //   loop). Then pick the first prospect that appears.
      await inpEl.focus();
      await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 700));   // wait for unfiltered list

      const firstPicked = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('.disco-select__option'));
        if (opts.length === 0) return null;
        const opt = opts[0];
        const propsKey = Object.keys(opt).find(k => k.startsWith('__reactProps'));
        const onClick = propsKey ? opt[propsKey]?.onClick : null;
        if (typeof onClick !== 'function') return null;
        try {
          onClick({
            target: opt, currentTarget: opt, type: 'click', button: 0,
            defaultPrevented: false, preventDefault: () => {}, stopPropagation: () => {}
          });
          return opt.innerText.trim();
        } catch(e) { return null; }
      });
      if (firstPicked) {
        console.warn(`[ORG] ⚠️ "Relive cure" not matched in any search — fell back to first prospect: "${firstPicked}". Investigate why Refrens isn't returning it.`);
        return { picked: firstPicked, reason: 'first_available_after_clear' };
      }

      await page.keyboard.press('Escape').catch(() => {});
      return { picked: null, reason: 'no_options_at_all' };
    }

    // Picks "Relive cure" option by calling the React props.onClick handler
    // directly. Proven via MCP browser inspection (May 2026):
    //   - React-Select v3 options have onClick (not onMouseDown) in props
    //   - page.mouse.click() does NOT trigger the onClick because of how
    //     React's synthetic event system / event delegation works in headless
    //   - Calling props.onClick({...}) directly DOES update React state
    //     (verified: URL changed to /leads/<new-id>)
    async function tryClickReliveMatch() {
      return await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('.disco-select__option'));
        const match = opts.find(o => /relive\s*cure/i.test(o.innerText))
                   || opts.find(o => /relive/i.test(o.innerText));
        if (!match) return null;
        const propsKey = Object.keys(match).find(k => k.startsWith('__reactProps'));
        const onClick = propsKey ? match[propsKey]?.onClick : null;
        if (typeof onClick === 'function') {
          try {
            onClick({
              target: match, currentTarget: match, type: 'click', button: 0,
              defaultPrevented: false,
              preventDefault: () => {}, stopPropagation: () => {}
            });
            return match.innerText.trim();
          } catch(e) { /* fall through */ }
        }
        // Fallback: native click (won't actually pick but lets us log)
        match.click();
        return null;
      });
    }

    try {
      const result = await pickProspectOrganisation();
      console.log(`[ORG] result: picked="${result.picked || '(none)'}" reason="${result.reason}"`);
      if (!result.picked) {
        console.warn('[ORG] No prospect could be selected — submit will likely fail with required-field error');
      }
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.warn(`[ORG] error: ${e.message}`);
    }

    const t_fill = Date.now();

    // ── 4. Stage — find dropdown by LABEL (not positional index) ─────────────
    // The form was reordered (May 2026); index 3 is no longer guaranteed to be
    // the Stage dropdown. Find it by its "Select Stage" label.
    const stageLabel = getStage(lead.intent_level);
    const stageId    = STAGE_ID_MAP[stageLabel] || STAGE_ID_MAP['Open'];
    const stageIdx = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.disco-select__control'));
      for (let i = 0; i < all.length; i++) {
        let cur = all[i];
        for (let d = 0; d < 6 && cur; d++) {
          cur = cur.parentElement;
          if (!cur) break;
          const lbl = cur.querySelector('label,h4,h5,h6,.form-label,[class*="label"]');
          if (lbl && /select\s*stage|^stage\s*$|^stage\s*\*/i.test(lbl.innerText || lbl.textContent || '')) {
            return i;
          }
        }
      }
      return -1;
    });
    console.log(`[CRM] Stage dropdown found at index ${stageIdx}`);
    if (stageIdx >= 0) {
      const stageSet = await setDiscoSelectByIndex(page, stageIdx, stageId, stageLabel);
      if (!stageSet) {
        console.warn('[CRM] Stage fiber set failed — leaving default "Open"');
      }
    } else {
      console.warn('[CRM] Stage dropdown not found by label — leaving default "Open"');
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
    // F4: Use React-aware setter for all fields.
    //  - Phone: MUST include "+91" prefix (proven via MCP browser test).
    //    The phone-input library rejects raw "9999900099" and resets to "+91".
    //    Setting "+919999900099" via native setter produces "+91 99999-00099"
    //    formatted display AND submits correctly.
    const nameSet  = await setReactInputValue(page, SEL.contactName, realName);
    if (!nameSet)  await fillField(page, SEL.contactName, realName);

    // Phone: ALWAYS prepend +91 for India (Refrens's phone-input requires E.164)
    const phoneE164 = '+91' + cleanPhone.replace(/\D/g, '').replace(/^91/, '');
    const phoneSet = await setReactInputValue(page, SEL.contactPhone, phoneE164);
    if (!phoneSet) await fillField(page, SEL.contactPhone, phoneE164);

    const cityVal = (lead.city && lead.city.trim()) ? lead.city.trim() : '';
    let citySet = false;
    if (cityVal) {
        citySet = await setReactInputValue(page, SEL.customerCity, cityVal);
        if (!citySet) await fillField(page, SEL.customerCity, cityVal);
    }

    console.log(`[CRM] Field fill: name=${nameSet} phone=${phoneSet}(E164="${phoneE164}") city=${citySet}(val="${cityVal}")`);

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
      window.__crm_net__ = [];
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

    // Capture network requests during submit so we can see if Refrens's
    // backend rejected the lead-create API call.
    const submitNetCalls = [];
    const netListener = (resp) => {
      try {
        const u = resp.url();
        const method = resp.request().method();
        // Capture every refrens.com POST/PUT — submit might use any endpoint name
        if (u.includes('refrens.com') && method !== 'GET' && method !== 'OPTIONS') {
          submitNetCalls.push({ url: u.slice(0, 200), status: resp.status(), method });
        }
      } catch(_) {}
    };
    page.on('response', netListener);

    // Diag: log submit button state + all critical field values right before click
    const preClickDiag = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      const allInputs = {};
      document.querySelectorAll('input,textarea').forEach(el => {
        if (el.type === 'hidden' || !el.name) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        allInputs[el.name] = (el.value || '').slice(0, 40);
      });
      const allSelects = Array.from(document.querySelectorAll('.disco-select__control')).map((c, i) => {
        let label = '';
        let cur = c;
        for (let d = 0; d < 5 && cur; d++) {
          cur = cur.parentElement;
          if (!cur) break;
          const lbl = cur.querySelector('label,h4,h5,h6,.form-label,[class*="label"]');
          if (lbl) { label = (lbl.innerText || '').trim().slice(0, 30); break; }
        }
        return { i, label, val: c.querySelector('.disco-select__single-value')?.innerText?.trim() || '(empty)' };
      });
      return {
        submitBtn: btn ? { disabled: btn.disabled, text: (btn.innerText || '').trim().slice(0, 40), visible: btn.offsetParent !== null } : null,
        inputs: allInputs,
        selects: allSelects
      };
    });
    console.log(`[CRM] Pre-click state:`, JSON.stringify(preClickDiag));

    // Submit click: same root cause as the org option — page.click()'s real
    // mouse event does NOT fire React's onClick in headless context. Use
    // the DOM .click() method via page.evaluate (proven by MCP test: lead
    // 6a11c9d982c97a0012c7c16c was created with this exact path).
    const clickResult = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return { ok: false, reason: 'btn_not_found' };
      if (btn.disabled) return { ok: false, reason: 'btn_disabled' };
      btn.click();
      return { ok: true };
    }, SEL.submit);
    console.log(`[CRM] Submit click via DOM:`, JSON.stringify(clickResult));
    // Give it a beat then wait for navigation
    await page.waitForNavigation({ timeout: 18000 }).catch(() => {});

    // After clicking, wait a beat — Refrens may run async client-side validation
    // (e.g. dedup check, phone format) before either showing an error or routing.
    await new Promise(r => setTimeout(r, 1500));

    // ── 11. Validate success (URL should change from /new) ────────────────────
    let postUrl = page.url();
    let urlChanged = !postUrl.endsWith('/new') && !postUrl.endsWith('/new/');

    // Second-chance: Refrens may finish the lead-create async (network roundtrip
    // to backend before the redirect). Wait up to 8s for the URL to change.
    if (!urlChanged) {
      try {
        await page.waitForFunction(
          () => !location.href.endsWith('/new') && !location.href.endsWith('/new/'),
          { timeout: 8000 }
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
        // F1: tighter "required" detection. The old body-wide /required/i scan
        // matched field-label helper text on EVERY page load (false positive).
        // Now we only flag `required` when an INLINE validation element shows
        // the word — i.e. an actual validation message after failed submit.
        const inlineValidationEls = Array.from(document.querySelectorAll(
          '.form-error,.invalid-feedback,[class*="error-msg"],[class*="errorText"],[class*="error-message"],.disco-select__control--is-invalid,[class*="field-error"],[role="alert"],[class*="ant-form-item-explain-error"]'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const inlineText = inlineValidationEls.map(el => (el.innerText || '').trim()).join(' | ');
        // Which specific fields are flagged invalid?
        const invalidFields = [];
        document.querySelectorAll('.disco-select__control--is-invalid,input.is-invalid,input[aria-invalid="true"]').forEach(el => {
          let cur = el;
          for (let d = 0; d < 6 && cur; d++) {
            cur = cur.parentElement;
            if (!cur) break;
            const lbl = cur.querySelector('label,h4,h5,h6,.form-label,[class*="label"]');
            if (lbl) {
              const t = (lbl.innerText || '').trim();
              if (t) { invalidFields.push(t.slice(0, 60)); break; }
            }
          }
        });
        return {
          errs,
          visibleErrs,
          inlineText: inlineText.slice(0, 400),
          invalidFields: [...new Set(invalidFields)].slice(0, 8),
          bodyHas: {
            // ONLY true if an inline validation element actually said it
            required: /required|cannot be empty|please (?:fill|enter|select)/i.test(inlineText),
            invalid:  /invalid|incorrect format/i.test(inlineText),
            duplicate:/already exist|duplicate/i.test(inlineText) || /already exist|duplicate/i.test(document.body.innerText),
            phone:    /phone|mobile/i.test(inlineText) && /invalid|incorrect|format/i.test(inlineText)
          },
          url: location.href
        };
      });

      // Include network calls captured during submit
      diag.networkCalls = submitNetCalls.slice(-12);
      page.off('response', netListener);
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
        const fieldsList = (diag.invalidFields || []).join(', ');
        throw new Error(`Refrens rejected: required field missing${fieldsList ? ' (' + fieldsList + ')' : ''}${surfaced ? ' — ' + surfaced : ''}`);
      }
      if (surfaced) {
        throw new Error(`Refrens rejected submit: ${surfaced}`);
      }
      // Include a compact diag snapshot in the error so it surfaces in the
      // API response (Railway log is also written, but the dashboard sees this).
      const compactDiag = {
        url: diag.url,
        inv: diag.invalidFields,
        net: (diag.networkCalls || []).map(n => `${n.method} ${n.status} ${n.url.slice(-60)}`),
        pre: preClickDiag,
      };
      throw new Error('Submit clicked but URL did not change. Diag: ' + JSON.stringify(compactDiag).slice(0, 1200));
    }

    // ── 12. Post-create: set Lead Assignee if specified ──────────────────────
    // Refrens's new-lead form has NO assignee field. After submit, the lead's
    // detail page has a "Lead assignee" widget that defaults to the workspace
    // owner ("Relive Cure"). To assign to a teammate, we click the edit
    // pencil → type name → click radio → "Save Changes" → "Yes, Transfer Lead".
    if (lead.assignee && typeof lead.assignee === 'string' && lead.assignee.trim().length >= 2) {
      try {
        const ok = await assignLeadToCollaborator(page, lead.assignee.trim());
        if (ok) {
          console.log(`[CRM] ✅ Assigned to "${lead.assignee}"`);
        } else {
          console.warn(`[CRM] ⚠️ Could not assign to "${lead.assignee}" — lead created but assignee left as default`);
        }
      } catch(e) {
        console.warn(`[CRM] Assignee step failed: ${e.message} — lead is still created`);
      }
    }

    const t_done = Date.now();
    try { page.off('response', netListener); } catch(_) {}

    // Capture the Refrens lead URL + ID for deep-linking from the dashboard
    const refrensUrl = page.url();
    const refrensIdMatch = refrensUrl.match(/\/leads\/([a-f0-9]{20,})/i);
    const refrensId = refrensIdMatch ? refrensIdMatch[1] : null;

    console.log(`[CRM] ✅ lead_id=${lead.id} name="${realName}" stage="${stageLabel}" assignee="${lead.assignee || '(default)'}" refrens="${refrensUrl}" | t_open=${t_fill - t_open}ms t_fill=${t_submit - t_fill}ms t_submit=${t_done - t_submit}ms total=${t_done - t_open}ms`);

    return { success: true, id: lead.id, refrens_url: refrensUrl, refrens_id: refrensId };

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
