/**
 * Probe the real org dropdown: div[role="button"][aria-haspopup="listbox"]
 * Click it, wait for options, log all option text + selectors
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
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Find the listbox button
  const listboxBtns = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div[role="button"][aria-haspopup="listbox"]'));
    return els.map((el, i) => ({
      index: i,
      text: el.innerText.trim().substring(0, 60),
      classes: el.className.substring(0, 80),
      parentText: el.closest('[class]')?.className?.substring(0, 80) || ''
    }));
  });

  console.log('═══ div[role="button"][aria-haspopup="listbox"] elements ═══');
  listboxBtns.forEach(b => console.log(`[${b.index}] text="${b.text}" class="${b.classes}"`));

  // Click the first one
  const orgBtn = await page.$('div[role="button"][aria-haspopup="listbox"]');
  if (!orgBtn) {
    console.error('No listbox button found!');
    await browser.close(); return;
  }

  await orgBtn.click();
  console.log('\nClicked org button. Waiting for listbox/options...');
  await new Promise(r => setTimeout(r, 1500));

  // Dump all newly appeared elements that look like options
  const afterClick = await page.evaluate(() => {
    // Try various option selectors
    const byRole = Array.from(document.querySelectorAll('[role="option"]')).map(el => ({
      type: 'role=option', text: el.innerText.trim(), id: el.id, cls: el.className.substring(0,60)
    }));
    const byListbox = Array.from(document.querySelectorAll('[role="listbox"] li, [role="listbox"] div')).map(el => ({
      type: 'listbox child', text: el.innerText.trim().substring(0, 60), id: el.id, cls: el.className.substring(0,60)
    }));
    // All newly expanded roles
    const allExpanded = Array.from(document.querySelectorAll('[aria-expanded="true"]')).map(el => ({
      type: 'aria-expanded', tag: el.tagName, text: el.innerText.trim().substring(0,60), role: el.getAttribute('role')
    }));
    return { byRole, byListbox, allExpanded };
  });

  console.log('\n═══ [role="option"] after click ═══');
  if (afterClick.byRole.length > 0) {
    afterClick.byRole.forEach((o, i) => console.log(`  [${i}] "${o.text}"`));
  } else { console.log('  (none)'); }

  console.log('\n═══ listbox children after click ═══');
  if (afterClick.byListbox.length > 0) {
    afterClick.byListbox.slice(0,20).forEach((o, i) => console.log(`  [${i}] "${o.text}" cls="${o.cls}"`));
  } else { console.log('  (none)'); }

  console.log('\n═══ aria-expanded=true after click ═══');
  afterClick.allExpanded.forEach(e => console.log(`  <${e.tag}> role="${e.role}" text="${e.text}"`));

  // Screenshot with dropdown open
  await page.screenshot({ path: 'org-dropdown-open.png', fullPage: true });
  console.log('\nScreenshot: org-dropdown-open.png');

  // Also log raw body text of any overlay/portal
  const overlay = await page.evaluate(() => {
    const portals = document.querySelectorAll('[data-popper-placement], [class*="menu"], [class*="dropdown"], [class*="popup"], [class*="Popup"]');
    return Array.from(portals).map(el => el.innerText.trim().substring(0, 200));
  });
  console.log('\n═══ Overlay/portal text after click ═══');
  overlay.forEach((t, i) => console.log(`[${i}] "${t}"`));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
