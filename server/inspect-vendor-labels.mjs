import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';

(async () => {
  console.log('[LABEL MAP] Launching browser...');

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Map each vendorField input to its nearest label
  const labelMap = await page.evaluate(() => {
    // Strategy 1: walk up the DOM to find an adjacent label or legend
    function nearest(el, selector) {
      let node = el;
      while (node && node !== document.body) {
        const found = node.querySelector(selector);
        if (found) return found.innerText.trim();
        const sibling = node.previousElementSibling;
        if (sibling) {
          const found2 = sibling.querySelector(selector) || (sibling.matches(selector) ? sibling : null);
          if (found2) return found2.innerText.trim();
        }
        node = node.parentElement;
      }
      return '';
    }

    const results = [];

    // Get all visible inputs INCLUDING the vendor fields
    const inputs = Array.from(document.querySelectorAll('input[name^="vendorFields"], textarea[name^="vendorFields"]'));

    inputs.forEach(el => {
      // Try to find label by traversing parent containers
      let label = '';
      let container = el.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!container) break;
        // Check for label, span with class, or data-label style patterns
        const labelEl = container.querySelector('label, [class*="label"], [class*="Label"], [class*="title"], [class*="Title"]');
        if (labelEl) {
          const txt = labelEl.innerText.trim();
          if (txt && txt.length > 0 && txt.length < 100) {
            label = txt;
            break;
          }
        }
        container = container.parentElement;
      }

      results.push({
        name:        el.name,
        tag:         el.tagName.toLowerCase(),
        type:        el.type,
        label:       label,
        placeholder: el.placeholder || '',
        visible:     el.offsetParent !== null
      });
    });

    return results;
  });

  console.log('\n════════════════════════════════════════');
  console.log('VENDOR FIELDS WITH LABELS:');
  console.log('════════════════════════════════════════');
  labelMap.forEach((f, i) => {
    console.log(`[${i}] name="${f.name}" tag="${f.tag}" visible=${f.visible} label="${f.label}"`);
  });

  // Also take a full screenshot with labels visible
  await page.screenshot({ path: 'crm-vendor-fields.png', fullPage: true });
  console.log('\n[LABEL MAP] Screenshot saved: crm-vendor-fields.png');

  await browser.close();
})().catch(err => {
  console.error('[LABEL MAP] Fatal:', err);
  process.exit(1);
});
