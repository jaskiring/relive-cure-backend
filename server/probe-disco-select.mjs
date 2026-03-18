/**
 * DISCO-SELECT ORG PROBE
 * Uses correct disco-select CSS class selectors to:
 * 1. Click org dropdown control
 * 2. Wait for options (with screenshots)
 * 3. Select "jh Hussain" by text match
 * 4. Log all found options
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';
let shotIdx = 0;

async function shot(page, label) {
  const name = `disco-${String(++shotIdx).padStart(2,'0')}-${label}`;
  await page.screenshot({ path: `${name}.png`, fullPage: false });
  console.log(`[SHOT] ${name}.png`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1280,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.disco-select__control', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1000));
  await shot(page, 'loaded');

  // All disco-select controls on the page
  const controls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.disco-select__control')).map((el, i) => {
      const valueEl = el.querySelector('.disco-select__single-value, .disco-select__placeholder');
      return {
        index: i,
        currentValue: valueEl ? valueEl.innerText.trim() : '(empty)',
        inputId: el.querySelector('input')?.id || '',
        classes: el.className
      };
    });
  });

  console.log(`\nFound ${controls.length} disco-select controls:`);
  controls.forEach(c => console.log(`  [${c.index}] inputId="${c.inputId}" value="${c.currentValue}"`));

  // The ORG field is the first disco-select control (index 0)
  const orgControl = await page.$('.disco-select__control');
  if (!orgControl) { console.error('No disco-select__control found!'); await browser.close(); return; }

  // Click to open
  await orgControl.click();
  console.log('\nClicked org control. Waiting...');
  await new Promise(r => setTimeout(r, 1500));
  await shot(page, 'after-click');

  // What appeared?
  const afterClick = await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('.disco-select__option')).map(el => el.innerText.trim());
    const menu = document.querySelector('.disco-select__menu, .disco-select__menu-list');
    const menuText = menu ? menu.innerText.trim().substring(0, 400) : '(no menu)';
    const inputActive = document.querySelector('input#react-select-2-input');
    return { opts, menuText, hasInput: !!inputActive };
  });
  console.log('\nOptions after click:', afterClick.opts.join(' | ') || '(none)');
  console.log('Menu text:', afterClick.menuText);

  // Type "jh" to search
  if (afterClick.hasInput) {
    await page.type('input#react-select-2-input', 'jh', { delay: 100 });
    console.log('\nTyped "jh". Waiting 3s for API...');
    await new Promise(r => setTimeout(r, 3000));
    await shot(page, 'after-jh');

    const afterJh = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('.disco-select__option')).map(el => ({
        text: el.innerText.trim(),
        id: el.id,
        cls: el.className
      }));
      const noOpts = document.querySelector('.disco-select__menu-notice--no-options');
      const loading = document.querySelector('.disco-select__menu-notice--loading');
      return { opts, noOpts: noOpts?.innerText, loading: loading?.innerText };
    });
    console.log('\nAfter typing "jh":');
    console.log('  Options:', afterJh.opts.length > 0 ? afterJh.opts.map(o => `"${o.text}"`).join(', ') : '(none)');
    console.log('  No-options msg:', afterJh.noOpts || '(none)');
    console.log('  Loading msg:', afterJh.loading || '(none)');

    // Clear and try the full name
    for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 500));
    await page.type('input#react-select-2-input', 'Hussain', { delay: 100 });
    console.log('\nTyped "Hussain". Waiting 3s...');
    await new Promise(r => setTimeout(r, 3000));
    await shot(page, 'after-hussain');

    const afterHussain = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('.disco-select__option')).map(el => ({
        text: el.innerText.trim(), id: el.id
      }));
      const noOpts = document.querySelector('.disco-select__menu-notice--no-options');
      return { opts, noOpts: noOpts?.innerText };
    });
    console.log('\nAfter typing "Hussain":');
    console.log('  Options:', afterHussain.opts.length > 0 ? afterHussain.opts.map(o => `"${o.text}"`).join(', ') : '(none)');
    console.log('  No-options msg:', afterHussain.noOpts || '(none)');

    // Also try just empty (no search) — see default options
    for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 1000));
    await shot(page, 'after-clear');
    const afterClear = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('.disco-select__option')).map(el => el.innerText.trim());
      return opts;
    });
    console.log('\nAfter clearing (default list):');
    afterClear.forEach((o, i) => console.log(`  [${i}] "${o}"`));
  }

  await browser.close();
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
