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
    await page.evaluate((token) => {
      try { sessionStorage.setItem('__at', token); } catch(e) {}
    }, capturedToken);
    await page.waitForSelector('.disco-select__control', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500)); // let React hydrate

    // ── 3. Prospect Organisation (disco-select[1]) ────────────────────────────
    // Click the org dropdown and select the first available option
    try {
      const controls = await page.$$('.disco-select__control');
      if (controls.length >= 2) {
        await controls[1].click();
        await page.waitForSelector('.disco-select__option', { timeout: 4000 });
        await page.evaluate(() => {
          const opt = document.querySelector('.disco-select__option');
          if (opt) opt.click();
        });
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      console.warn('[CRM] Org dropdown: could not select option:', e.message);
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

    await Promise.all([
      page.waitForNavigation({ timeout: 12000 }).catch(() => {}),
      page.click(SEL.submit)
    ]);

    // ── 11. Validate success (URL should change from /new) ────────────────────
    const postUrl = page.url();
    const urlChanged = !postUrl.endsWith('/new') && !postUrl.endsWith('/new/');

    if (!urlChanged) {
      const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
      if (bodyText.includes('required field') || bodyText.includes('invalid')) {
        throw new Error('Form validation error on submit');
      }
      throw new Error('Submit clicked but URL did not change — form may have validation errors');
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