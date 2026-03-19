import puppeteer from 'puppeteer';
import crypto from 'crypto';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = '/opt/render/.cache/puppeteer-session';

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    console.log("[CRM] Launching new browser instance");
    console.log("PUPPETEER CACHE:", process.env.PUPPETEER_CACHE_DIR);

    const executablePath = puppeteer.executablePath();
    console.log("[CRM] Resolved Chrome path:", executablePath);

    browserInstance = await puppeteer.launch({
      headless: "new",
      executablePath,
      userDataDir: USER_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,900"
      ],
      timeout: 60000
    });
  }
  return browserInstance;
}

console.log('CRM automation loaded from:', import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// VERIFIED SELECTORS — extracted from live DOM via inspect-crm-dom.mjs
// Last verified: 2026-03-18
//
// STANDARD REFRENS FIELDS   (name attribute confirmed):
//   contact.name      → [0]  input[name="contact.name"]
//   contact.phone     → [4]  input[name="contact.phone"]   (type=tel)
//   customer.city     → [3]  input[name="customer.city"]
//   subject           → [9]  input[name="subject"]
//   details           → [10] textarea[name="details"]
//   submit            → button[type="submit"]  text="Add Lead"
//
// CUSTOM VENDOR FIELDS       (name=vendorFields.N.value, confirmed by label):
//   vendorFields.1.value  → label: phone_number
//   vendorFields.2.value  → label: when_would_you_prefer_to_undergo_the_lasik_treatment?
//   vendorFields.4.value  → label: which_city_would_you_prefer_for_treatment_
//   vendorFields.6.value  → label: do_you_have_medical_insurance_
//   vendorFields.8.value  → label: do_you_have_medical_insurance?   (duplicate, also fill)
//   vendorFields.20.value → label: last_user_message   (textarea)
//   vendorFields.21.value → label: bot_fallback
//   vendorFields.22.value → label: lead_type
//   vendorFields.23.value → label: parameters_completed
//
// ORGANISATION DROPDOWN:
//   disco-select index [0] = Contact Country (phone flag) → react-select-2-input
//   disco-select index [1] = Prospect Organisation        → react-select-3-input
//   Identified via label "Prospect Organisation" — use label-based lookup only
// ─────────────────────────────────────────────────────────────────────────────

const SEL = {
  // ── LAYER 1: CORE (standard Refrens fields)
  contactName:  'input[name="contact.name"]',
  contactPhone: 'input[name="contact.phone"]',
  customerCity: 'input[name="customer.city"]',
  subject:      'input[name="subject"]',
  details:      'textarea[name="details"]',
  submit:       'button[type="submit"]',

  // ── LAYER 2: EXTENDED (confirmed custom vendor fields)
  vPhoneNumber:  'input[name="vendorFields.1.value"]',
  vTimeline:     'input[name="vendorFields.2.value"]',
  vPrefCity:     'input[name="vendorFields.4.value"]',
  vInsurance1:   'input[name="vendorFields.6.value"]',
  vInsurance2:   'input[name="vendorFields.8.value"]',

  // ── LAYER 3: OPTIONAL (confirmed custom vendor fields)
  vLastMessage:  'textarea[name="vendorFields.20.value"]',
  vBotFallback:  'input[name="vendorFields.21.value"]',
  vLeadType:     'input[name="vendorFields.22.value"]',
  vParamsComp:   'input[name="vendorFields.23.value"]',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — fills ONE field, silently skips if selector not found
// ─────────────────────────────────────────────────────────────────────────────
async function fillField(page, selector, value, label, timeout = 6000) {
  if (value === null || value === undefined || value === '') {
    console.log(`[CRM] ⚠  Skipping "${label}" — empty value`);
    return false;
  }
  try {
    await page.waitForSelector(selector, { timeout });
    await page.type(selector, String(value));
    console.log(`[CRM] ✓  "${label}" filled`);
    return true;
  } catch (e) {
    console.log(`[CRM] ⚠  Skipping "${label}" — not found in DOM (${e.message.split('\n')[0]})`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export async function pushToCRM(lead, options = {}) {
  console.log("[CRM] Starting push for:", lead.phone_number);
  
  // Guard: ensure lead always has an id
  if (!lead.id) lead.id = crypto.randomUUID();

  console.log(`\n[CRM] ──────────────────────────────────`);
  console.log(`[CRM] Processing lead: ${lead.id}`);

  const browser = await getBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    console.log(`[CRM] Navigating to: ${CRM_FORM_URL}`);
    await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // ── Guard: detect login redirect ──────────
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('signin')) {
      console.error('[CRM] ❌ SESSION EXPIRED — redirected to login page!');
      console.error('[CRM] Run: node server/manual-login.js   to re-authenticate.');
      await page.close();
      return { success: false, id: lead.id, error: 'Session expired — login required' };
    }

    // ── Debug screenshot (initial page load) ──
    await page.screenshot({ path: 'crm-debug.png', fullPage: true });
    // console.log('[CRM] Debug screenshot saved: crm-debug.png');

    // ────────────────────────────────────────────────────────────────────────
    // ORGANISATION SELECTION
    // Strategy: find by LABEL TEXT "organisation" — NEVER by index.
    // Only the "Prospect Organisation" dropdown is touched.
    // ────────────────────────────────────────────────────────────────────────
    console.log('[CRM] ── ORGANISATION SELECTION ──');
    try {
      await page.waitForSelector('.disco-select__control', { timeout: 8000 });

      // Find the .disco-select__control whose nearest label says "organisation"
      const orgControl = await page.evaluateHandle(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const orgLabel = labels.find(l =>
          l.innerText.toLowerCase().includes('organisation') ||
          l.innerText.toLowerCase().includes('organization')
        );
        if (!orgLabel) return null;
        let container = orgLabel.parentElement;
        for (let i = 0; i < 4; i++) {
          const ctrl = container && container.querySelector('.disco-select__control');
          if (ctrl) return ctrl;
          container = container && container.parentElement;
        }
        return null;
      });

      const isNull = await page.evaluate(el => el === null, orgControl);
      if (isNull) throw new Error('Label "Prospect Organisation" + .disco-select__control not found in DOM');

      await orgControl.asElement().click();
      console.log('[CRM]   Org dropdown opened. Waiting for options...');
      await new Promise(r => setTimeout(r, 1500));

      const selectedResult = await page.evaluate((targetName) => {
        const opts = Array.from(document.querySelectorAll('.disco-select__option, [role="option"], .css-1n7v3ny-option'));
        const target = opts.find(el => {
          const txt = (el.innerText || '').trim().toLowerCase();
          return txt === targetName.toLowerCase();
        });
        if (target) { 
          const text = target.innerText.trim();
          target.click(); 
          return { found: true, text }; 
        }
        return { found: false, count: opts.length, labels: opts.map(o => o.innerText) };
      }, 'Relive cure');

      if (!selectedResult.found) {
        console.log(`[CRM]   Org "Relive cure" not in default list (${selectedResult.count} seen).`);
        console.log('[CRM]   Typing "Relive" to search...');
        const searchInput = await page.$('.disco-select__control input, #react-select-3-input');
        if (searchInput) {
          await searchInput.type('Relive', { delay: 150 });
          // Wait for options to appear
          await new Promise(r => setTimeout(r, 4000));
        }
        const afterSearch = await page.evaluate((targetName) => {
          const opts = Array.from(document.querySelectorAll('.disco-select__option, [role="option"], .css-1n7v3ny-option'));
          const target = opts.find(el => {
            const txt = (el.innerText || '').trim().toLowerCase();
            return txt === targetName.toLowerCase();
          });
          if (target) { 
            const text = target.innerText.trim();
            target.click(); 
            return { found: true, text }; 
          }
          return { found: false, labels: opts.map(o => o.innerText) };
        }, 'Relive cure');

        if (afterSearch.found) {
          console.log(`[CRM] ✅ Selected via search: "${afterSearch.text}"`);
        } else {
          console.log('[CRM] Final options seen after searching "Relive":', afterSearch.labels);
          throw new Error('❌ Prospect Organisation "Relive cure" NOT FOUND even after searching "Relive"');
        }
      } else {
        console.log(`[CRM] ✅ Selected: "${selectedResult.text}"`);
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`[CRM] ❌  FATAL: Org selection failed — ${e.message.split('\n')[0]}`);
      await page.close();
      return { success: false, id: lead.id || 'unknown', error: `Org selection failed: ${e.message}` };
    }

    // ────────────────────────────────────────────────────────────────────────
    // LAYER 1 — CORE FIELDS (standard Refrens fields, must succeed)
    // ────────────────────────────────────────────────────────────────────────
    console.log('[CRM] ── LAYER 1: CORE fields ──');

    await fillField(page, SEL.contactName,
      lead.contact_name || lead.name || 'WhatsApp Lead',
      'contact.name');

    await fillField(page, SEL.contactPhone,
      lead.phone_number,
      'contact.phone');

    await fillField(page, SEL.customerCity,
      lead.city,
      'customer.city');

    await fillField(page, SEL.subject,
      `LASIK - ${lead.preferred_surgery_city || 'General'}`,
      'subject');

    // Details block — carries ALL key data as readable text summary
    const description =
`Name: ${lead.contact_name || 'N/A'}
Phone: ${lead.phone_number || 'N/A'}
City: ${lead.city || 'N/A'}
Preferred Surgery City: ${lead.preferred_surgery_city || 'N/A'}
Insurance: ${lead.insurance || 'N/A'}
Timeline: ${lead.timeline || 'N/A'}
Lead Type: ${lead.lead_type || 'N/A'}
Last User Message: ${lead.last_user_message || 'N/A'}
Parameters Completed: ${lead.parameters_completed ?? 'N/A'} / 4
Bot Fallback: ${lead.bot_fallback ?? false}`;

    await fillField(page, SEL.details, description, 'details (summary block)');

    // ────────────────────────────────────────────────────────────────────────
    // LAYER 2 — EXTENDED FIELDS (confirmed vendorFields, best-effort)
    // ────────────────────────────────────────────────────────────────────────
    console.log('[CRM] ── LAYER 2: EXTENDED vendor fields ──');

    await fillField(page, SEL.vPhoneNumber, lead.phone_number,              'vendorFields.1 (phone_number)',    4000);
    await fillField(page, SEL.vTimeline,    lead.timeline,                  'vendorFields.2 (timeline)',        4000);
    await fillField(page, SEL.vPrefCity,    lead.preferred_surgery_city,    'vendorFields.4 (preferred_city)', 4000);
    await fillField(page, SEL.vInsurance1,  lead.insurance,                 'vendorFields.6 (insurance_1)',    4000);
    await fillField(page, SEL.vInsurance2,  lead.insurance,                 'vendorFields.8 (insurance_2)',    4000);

    // ────────────────────────────────────────────────────────────────────────
    // LAYER 3 — OPTIONAL FIELDS (confirmed vendorFields, silent skip ok)
    // ────────────────────────────────────────────────────────────────────────
    console.log('[CRM] ── LAYER 3: OPTIONAL vendor fields ──');

    await fillField(page, SEL.vLastMessage, lead.last_user_message,                  'vendorFields.20 (last_user_message)',   3000);
    await fillField(page, SEL.vBotFallback, String(lead.bot_fallback ?? false),      'vendorFields.21 (bot_fallback)',        3000);
    await fillField(page, SEL.vLeadType,    lead.lead_type || 'surgery',             'vendorFields.22 (lead_type)',           3000);
    await fillField(page, SEL.vParamsComp,  String(lead.parameters_completed ?? 0),  'vendorFields.23 (parameters_completed)', 3000);

    console.log("[CRM] Form filled");

    await page.screenshot({ path: 'before-submit.png', fullPage: true });

    // ────────────────────────────────────────────────────────────────────────
    // SUBMIT
    // ────────────────────────────────────────────────────────────────────────
    console.log('[CRM] ── SUBMITTING ──');
    let submitted = false;

    try {
      console.log("[CRM] Clicking submit");
      await page.waitForSelector(SEL.submit, { timeout: 5000 });
      await page.click(SEL.submit);
      submitted = true;
      console.log("[CRM] Lead submitted");
    } catch (e) {
      console.log('[CRM] ⚠  Primary submit failed — trying text fallback...');
      try {
        submitted = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b =>
            (b.innerText || '').toLowerCase().includes('add lead') ||
            (b.innerText || '').toLowerCase().includes('create') ||
            (b.innerText || '').toLowerCase().includes('save')
          );
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (submitted) console.log('[CRM] ✓  Fallback submit clicked');
      } catch (e2) {
        console.error('[CRM] ❌  Both submit attempts failed:', e2.message);
      }
    }

    await new Promise(r => setTimeout(r, 4000));
    await page.screenshot({ path: 'final-proof.png', fullPage: true });
    console.log("[CRM] Final proof screenshot saved: final-proof.png");

    // ────────────────────────────────────────────────────────────────────────
    // VALIDATION
    // ────────────────────────────────────────────────────────────────────────
    console.log('[CRM] ── VALIDATION ──');
    let hardSuccess = false;
    try {
      await page.waitForSelector('body', { timeout: 8000 });
      hardSuccess = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return (
          body.includes("lead created") ||
          body.includes("success") ||
          body.includes("added") ||
          body.includes("saved")
        );
      });
      console.log(`[CRM] Keyword-based success check: ${hardSuccess}`);
    } catch (e) {
      console.log("[CRM] Validation check failed:", e.message);
    }

    await page.close();

    if (hardSuccess) {
      console.log("[CRM] Successfully pushed:", lead.phone_number);
      console.log(`[CRM] ✅ CRM VALIDATION PASSED — lead confirmed in Refrens`);
      return { success: true, id: lead.id, validated: true };
    } else {
      console.error(`[CRM] ❌ CRM VALIDATION FAILED`);
      return { success: false, id: lead.id, validated: false, error: 'Confirmation message not found' };
    }

  } catch (error) {
    console.error("[CRM ERROR]", error.message);
    if (page) await page.close();
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
