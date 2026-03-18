import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  console.log('[INSPECT] Launching browser with saved session...');
  console.log('[INSPECT] Target URL:', CRM_FORM_URL);

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log('[INSPECT] Navigating...');
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // ── Screenshot BEFORE inspection ───────────
  const screenshotPath = path.join(__dirname, '..', 'crm-debug.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('[INSPECT] Screenshot saved to:', screenshotPath);

  // ── Check final URL (detect login redirect) ─
  const finalUrl = page.url();
  console.log('[INSPECT] Final page URL:', finalUrl);

  if (finalUrl.includes('login') || finalUrl.includes('signin')) {
    console.error('[INSPECT] ❌ SESSION EXPIRED — page redirected to login!');
    console.error('[INSPECT] Run node server/manual-login.js to re-authenticate.');
    await browser.close();
    process.exit(1);
  }

  // ── Dump ALL input/textarea/select fields ──
  const fields = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input, textarea, select'));
    return els.map(el => ({
      tag:         el.tagName.toLowerCase(),
      type:        el.type || '',
      name:        el.name || '',
      id:          el.id || '',
      placeholder: el.placeholder || '',
      className:   el.className || '',
      value:       el.value || '',
      visible:     el.offsetParent !== null
    }));
  });

  console.log('\n════════════════════════════════════════');
  console.log('AVAILABLE INPUT FIELDS (' + fields.length + ' total):');
  console.log('════════════════════════════════════════');
  fields.forEach((f, i) => {
    console.log(`[${i}] <${f.tag}> type="${f.type}" name="${f.name}" id="${f.id}" placeholder="${f.placeholder}" visible=${f.visible}`);
  });

  // ── Also dump all buttons ──────────────────
  const buttons = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.map(b => ({
      type:    b.type || '',
      text:    (b.innerText || '').trim().substring(0, 60),
      id:      b.id || '',
      classes: b.className || ''
    }));
  });

  console.log('\n════════════════════════════════════════');
  console.log('AVAILABLE BUTTONS (' + buttons.length + ' total):');
  console.log('════════════════════════════════════════');
  buttons.forEach((b, i) => {
    console.log(`[${i}] <button> type="${b.type}" id="${b.id}" text="${b.text}"`);
  });

  // ── Look for known field candidates ────────
  console.log('\n════════════════════════════════════════');
  console.log('FIELD MATCHING ANALYSIS:');
  console.log('════════════════════════════════════════');
  const targets = ['name', 'phone', 'city', 'organisation', 'organization', 'subject', 'detail', 'message', 'note', 'timeline', 'insurance', 'surgery'];
  targets.forEach(keyword => {
    const matches = fields.filter(f =>
      f.name.toLowerCase().includes(keyword) ||
      f.id.toLowerCase().includes(keyword) ||
      f.placeholder.toLowerCase().includes(keyword)
    );
    if (matches.length > 0) {
      console.log(`\n✅ Keyword "${keyword}" matches:`);
      matches.forEach(m => console.log(`   → <${m.tag}> name="${m.name}" id="${m.id}" placeholder="${m.placeholder}"`));
    } else {
      console.log(`❌ No match for "${keyword}"`);
    }
  });

  await browser.close();
  console.log('\n[INSPECT] Done.');
})().catch(err => {
  console.error('[INSPECT] Fatal error:', err);
  process.exit(1);
});
