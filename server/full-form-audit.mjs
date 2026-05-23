/**
 * Full Refrens "Add New Lead" Form Audit
 * Uses REFRENS_COOKIES from .env — no local puppeteer session needed
 * Dumps every field, dropdown option, and custom field available
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const COOKIES_RAW = process.env.REFRENS_COOKIES;

async function waitForTokenRefresh(page, timeoutMs = 20000) {
  await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  try {
    await page.waitForFunction(
      () => { const at = sessionStorage.getItem('__at'); return !!at && at.length > 20; },
      { timeout: timeoutMs, polling: 300 }
    );
    return true;
  } catch (_) { return false; }
}

(async () => {
  if (!COOKIES_RAW) { console.error('REFRENS_COOKIES not set in .env'); process.exit(1); }

  const cookies = JSON.parse(COOKIES_RAW);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Set cookies
  await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));
  console.log('[AUDIT] Cookies set, waiting for token refresh...');

  const tokenOk = await waitForTokenRefresh(page, 15000);
  console.log('[AUDIT] Token refresh:', tokenOk ? '✅' : '❌ (continuing anyway)');

  const capturedToken = await page.evaluate(() => sessionStorage.getItem('__at'));
  await page.evaluateOnNewDocument(tok => {
    try { sessionStorage.setItem('__at', tok); } catch(e) {}
  }, capturedToken);

  await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate(tok => { try { sessionStorage.setItem('__at', tok); } catch(e) {} }, capturedToken);

  const finalUrl = page.url();
  console.log('[AUDIT] Final URL:', finalUrl);
  if (finalUrl.includes('login') || finalUrl.includes('signin')) {
    console.error('[AUDIT] ❌ Redirected to login — session expired. Update REFRENS_COOKIES.');
    await browser.close(); process.exit(1);
  }

  // Wait for form
  try {
    await page.waitForSelector('input, .disco-select__control', { timeout: 10000 });
  } catch(e) { console.warn('[AUDIT] Form may not have loaded fully'); }
  await new Promise(r => setTimeout(r, 2000));

  // ── 1. ALL INPUT / TEXTAREA / SELECT fields ───────────────────────────────
  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea,select')).map(el => ({
      tag: el.tagName, type: el.type||'', name: el.name||'', id: el.id||'',
      placeholder: el.placeholder||'', value: el.value||'', visible: el.offsetParent !== null
    }))
  );

  console.log('\n══════════════════════════════════════════════');
  console.log(`INPUT/TEXTAREA/SELECT FIELDS (${fields.length} total)`);
  console.log('══════════════════════════════════════════════');
  fields.forEach((f,i) => {
    console.log(`[${i}] <${f.tag.toLowerCase()}> type="${f.type}" name="${f.name}" id="${f.id}" placeholder="${f.placeholder}" visible=${f.visible}`);
  });

  // ── 2. ALL DISCO-SELECT controls with nearby labels ───────────────────────
  const discoControls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.disco-select__control')).map((el, i) => {
      let node = el;
      let label = '';
      for (let d = 0; d < 8; d++) {
        node = node.parentElement;
        if (!node) break;
        const lbl = node.querySelector('label,[class*="label"],[class*="Label"]');
        if (lbl) { label = lbl.innerText.trim(); break; }
        // also check previous sibling's text
        const prev = node.previousElementSibling;
        if (prev && prev.innerText && prev.innerText.trim().length > 0 && prev.innerText.trim().length < 100) {
          label = prev.innerText.trim(); break;
        }
      }
      return {
        index: i,
        label,
        placeholder: el.querySelector('.disco-select__placeholder')?.innerText?.trim() || '',
        currentValue: el.querySelector('.disco-select__single-value')?.innerText?.trim() || '',
        inputId: el.querySelector('input')?.id || ''
      };
    })
  );

  console.log('\n══════════════════════════════════════════════');
  console.log(`DISCO-SELECT DROPDOWNS (${discoControls.length} total)`);
  console.log('══════════════════════════════════════════════');
  discoControls.forEach(c => {
    console.log(`[${c.index}] label="${c.label}" placeholder="${c.placeholder}" value="${c.currentValue}" inputId="${c.inputId}"`);
  });

  // ── 3. Click each disco-select and capture options ────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('DISCO-SELECT OPTIONS (clicking each one)');
  console.log('══════════════════════════════════════════════');
  const allControls = await page.$$('.disco-select__control');
  for (let i = 0; i < allControls.length; i++) {
    try {
      // Re-query each time (DOM may change)
      const ctrls = await page.$$('.disco-select__control');
      if (i >= ctrls.length) break;
      await ctrls[i].click();
      await new Promise(r => setTimeout(r, 1500));
      const opts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
      );
      console.log(`\n[${i}] "${discoControls[i]?.label || '?'}": ${opts.length} options`);
      opts.forEach(o => console.log(`     → "${o}"`));
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {
      console.log(`[${i}] ERROR: ${e.message}`);
      await page.keyboard.press('Escape').catch(()=>{});
    }
  }

  // ── 4. Native <select> options ────────────────────────────────────────────
  const nativeSelects = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select')).map(el => ({
      name: el.name||'', id: el.id||'',
      options: Array.from(el.options).map(o => o.text)
    }))
  );
  if (nativeSelects.length > 0) {
    console.log('\n══════════════════════════════════════════════');
    console.log(`NATIVE <SELECT> ELEMENTS (${nativeSelects.length})`);
    console.log('══════════════════════════════════════════════');
    nativeSelects.forEach(s => {
      console.log(`  name="${s.name}" id="${s.id}": ${s.options.join(' | ')}`);
    });
  }

  // ── 5. Section headings / form labels ─────────────────────────────────────
  const allLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('label, h2, h3, h4, [class*="section-title"], [class*="form-label"]'))
      .map(el => el.innerText?.trim())
      .filter(t => t && t.length > 0 && t.length < 120)
  );
  console.log('\n══════════════════════════════════════════════');
  console.log('FORM SECTION LABELS');
  console.log('══════════════════════════════════════════════');
  [...new Set(allLabels)].forEach(l => console.log(`  "${l}"`));

  // ── 6. Custom fields — open the custom field selector and read all options ─
  console.log('\n══════════════════════════════════════════════');
  console.log('CUSTOM FIELDS — Full Names');
  console.log('══════════════════════════════════════════════');
  // Find "Select any custom field" placeholder
  const customFieldControl = await page.evaluateHandle(() => {
    const placeholders = Array.from(document.querySelectorAll('[class*="placeholder"]'));
    return placeholders.find(p => p.innerText?.toLowerCase().includes('custom field'))
      ?.closest('[class*="control"]') || null;
  });
  if (customFieldControl && customFieldControl.asElement()) {
    await customFieldControl.click();
    await new Promise(r => setTimeout(r, 1500));
    const cfOpts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
    );
    console.log(`Found ${cfOpts.length} custom fields:`);
    cfOpts.forEach((o,i) => console.log(`  [${i}] "${o}"`));
    await page.keyboard.press('Escape');
  } else {
    // Try to find by text scanning
    const customFieldBtn = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      return !!els.find(e => e.innerText?.trim() === 'Select any custom field');
    });
    console.log('Custom field selector found via text scan:', customFieldBtn);
  }

  // ── 7. Assignee field — does it exist? ────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('ASSIGNEE / OWNER FIELD CHECK');
  console.log('══════════════════════════════════════════════');
  const assigneeInfo = await page.evaluate(() => {
    const keywords = ['assignee', 'assign', 'owner', 'rep', 'salesperson', 'agent'];
    const allEls = Array.from(document.querySelectorAll('*'));
    const matches = allEls
      .filter(e => e.children.length === 0) // leaf nodes
      .filter(e => {
        const t = (e.innerText||'').trim().toLowerCase();
        return keywords.some(k => t.includes(k)) && t.length < 60;
      })
      .map(e => ({ tag: e.tagName, text: e.innerText?.trim(), class: e.className?.substring(0,60) }));
    return matches.slice(0, 20);
  });
  if (assigneeInfo.length > 0) {
    assigneeInfo.forEach(a => console.log(`  Found: <${a.tag}> "${a.text}"`));
  } else {
    console.log('  ❌ No assignee/owner field found in form DOM');
  }

  // ── 8. Full page text for any missed fields ───────────────────────────────
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('\n══════════════════════════════════════════════');
  console.log('FULL PAGE TEXT (first 3000 chars)');
  console.log('══════════════════════════════════════════════');
  console.log(bodyText);

  await page.screenshot({ path: '/Users/jaskiring/Relive cure v2/form-audit.png', fullPage: true });
  console.log('\n[AUDIT] Screenshot saved to form-audit.png');

  await browser.close();
  console.log('[AUDIT] Done ✅');
})().catch(e => { console.error('[AUDIT] Fatal:', e); process.exit(1); });
