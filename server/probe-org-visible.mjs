/**
 * Probe: what does the org dropdown show?
 * - Take screenshot with dropdown open  
 * - Check for "Create", "Add new", "No options" text
 * - Check if field is actually required or just optional
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';

(async () => {
  const browser = await puppeteer.launch({
    headless: false, // VISIBLE so we can see what's happening
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    args: ['--no-sandbox','--disable-setuid-sandbox','--window-size=1280,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input#react-select-2-input', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));

  // Click the org field container (not the input directly)
  // Find what wraps react-select-2-input
  const containerInfo = await page.evaluate(() => {
    const input = document.querySelector('input#react-select-2-input');
    if (!input) return 'INPUT NOT FOUND';
    let container = input.parentElement;
    const info = [];
    for (let i = 0; i < 5; i++) {
      if (!container) break;
      info.push(`${container.tagName} class="${container.className.substring(0,80)}"`);
      container = container.parentElement;
    }
    return info.join('\n');
  });
  console.log('Org input parent chain:\n', containerInfo);

  // Click the org input
  await page.click('input#react-select-2-input');
  await new Promise(r => setTimeout(r, 500));

  // Type "jh hussain" — the full name
  await page.type('input#react-select-2-input', 'jh hussain', { delay: 80 });
  await new Promise(r => setTimeout(r, 3000));

  // Screenshot with the dropdown open
  await page.screenshot({ path: 'org-search-full.png', fullPage: false });
  console.log('Screenshot: org-search-full.png');

  // Get full HTML of the dropdown menu
  const menuHtml = await page.evaluate(() => {
    // Find the menu by common react-select menu class patterns
    const menus = document.querySelectorAll('[id*="react-select-2-listbox"], [class*="MenuList"], [class*="menu-list"]');
    if (menus.length > 0) return Array.from(menus).map(m => m.outerHTML.substring(0, 500)).join('\n---\n');
    // Fallback: find any dropdown-like overlay
    const dropdowns = document.querySelectorAll('[class*="dropdown"], [class*="Dropdown"], [class*="popup"]');
    return Array.from(dropdowns).map(d => d.innerText.trim().substring(0, 200)).join('\n---\n');
  });
  console.log('\nMenu HTML after typing:\n', menuHtml || '(nothing found)');

  // Check for "create" or "add" option
  const createOption = await page.evaluate(() => {
    const allText = document.body.innerText;
    const hasCreate = allText.toLowerCase().includes('create');
    const hasAdd = allText.toLowerCase().includes('add new');
    const hasNoOpts = allText.toLowerCase().includes('no options');
    return { hasCreate, hasAdd, hasNoOpts };
  });
  console.log('\nDropdown signals:', createOption);

  // Wait 10 seconds for user to visually inspect
  console.log('\nKeeping browser open for 10s...');
  await new Promise(r => setTimeout(r, 10000));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
