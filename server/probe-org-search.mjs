/**
 * Probe the org search field (input#react-select-2-input)
 * Try multiple search strings and log what the API returns
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';

const SEARCH_TERMS = ['jh', 'Hussain', 'hussain', 'j', 'Relive', 'relive', 'a'];

async function getOptions(page) {
  return page.evaluate(() => {
    const byId    = Array.from(document.querySelectorAll('[id*="react-select-2-option"]')).map(el => el.innerText.trim());
    const byRole  = Array.from(document.querySelectorAll('[role="option"]')).map(el => el.innerText.trim());
    const byClass = Array.from(document.querySelectorAll('[class*="option"]')).map(el => el.innerText.trim()).filter(t => t.length > 0 && t.length < 100);
    return { byId, byRole, byClass: [...new Set(byClass)].slice(0, 20) };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true, userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });

  for (const term of SEARCH_TERMS) {
    const page = await browser.newPage();
    await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input#react-select-2-input', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    // Click to focus
    await page.click('input#react-select-2-input');
    await new Promise(r => setTimeout(r, 500));
    await page.type('input#react-select-2-input', term, { delay: 100 });
    console.log(`\n─── Searching: "${term}" ───`);
    await new Promise(r => setTimeout(r, 2500)); // wait for API

    const opts = await getOptions(page);
    console.log(`  byId   (${opts.byId.length}):  `, opts.byId.join(' | ') || '(none)');
    console.log(`  byRole (${opts.byRole.length}): `, opts.byRole.join(' | ') || '(none)');
    console.log(`  byClass(${opts.byClass.length}):`, opts.byClass.join(' | ') || '(none)');

    await page.close();
  }

  await browser.close();
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
