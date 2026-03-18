/**
 * Map every disco-select control to its nearby label
 * to find which index = "Prospect Organisation"
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';

(async () => {
  const browser = await puppeteer.launch({
    headless: true, userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });
  const page = await browser.newPage();
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.disco-select__control', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1000));

  const info = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.disco-select__control')).map((el, i) => {
      // Walk up to find enclosing form group, then look for label
      let node = el;
      let label = '';
      for (let depth = 0; depth < 6; depth++) {
        node = node.parentElement;
        if (!node) break;
        const lbl = node.querySelector('label, [class*="label"], [class*="Label"]');
        if (lbl) { label = lbl.innerText.trim(); break; }
        if (node.previousElementSibling) {
          const prev = node.previousElementSibling;
          if (prev.tagName === 'LABEL' || prev.innerText.trim().length < 80) {
            label = prev.innerText.trim(); break;
          }
        }
      }
      const inputId = el.querySelector('input')?.id || '';
      const placeholder = el.querySelector('.disco-select__placeholder')?.innerText?.trim() || '';
      const singleValue = el.querySelector('.disco-select__single-value')?.innerText?.trim() || '';
      return { index: i, label, inputId, placeholder, singleValue };
    });
  });

  console.log('\n═══ DISCO-SELECT CONTROLS MAP ═══');
  info.forEach(c => {
    console.log(`[${c.index}] label="${c.label}" inputId="${c.inputId}" placeholder="${c.placeholder}" value="${c.singleValue}"`);
  });

  // Now click each one briefly to see what opens (country list vs business list)
  for (const ctrl of info.slice(0, 6)) {
    const selector = `.disco-select__control:nth-of-type(${ctrl.index + 1})`;
    try {
      const controls = await page.$$('.disco-select__control');
      if (ctrl.index >= controls.length) continue;
      await controls[ctrl.index].click();
      await new Promise(r => setTimeout(r, 1200));

      const opts = await page.evaluate(() => {
        const o = Array.from(document.querySelectorAll('.disco-select__option')).slice(0, 5).map(el => el.innerText.trim());
        const noOpts = document.querySelector('.disco-select__menu-notice--no-options')?.innerText;
        return { o, noOpts };
      });

      console.log(`\n  [${ctrl.index}] Click result: ${opts.o.length > 0 ? opts.o.join(' | ') : (opts.noOpts || 'no options text')} `);
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.log(`  [${ctrl.index}] Error: ${e.message}`);
    }
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
