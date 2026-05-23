/**
 * Probe: Custom Fields interaction in Refrens new lead form
 * Opens the form, adds each custom field one by one,
 * and dumps the resulting input's name/type/selector
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';

async function waitForToken(page) {
  await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: 15000 });
  try {
    await page.waitForFunction(() => { const at = sessionStorage.getItem('__at'); return !!at && at.length > 20; }, { timeout: 12000 });
    return await page.evaluate(() => sessionStorage.getItem('__at'));
  } catch(_) { return null; }
}

// Click disco-select placeholder text and type/select
async function selectCustomField(page, keyword) {
  // Find "Select any custom field" control
  const found = await page.evaluate(() => {
    const placeholders = Array.from(document.querySelectorAll('[class*="placeholder"]'));
    const cf = placeholders.find(p => p.innerText?.toLowerCase().includes('custom field') || p.innerText?.toLowerCase().includes('select any'));
    return !!cf;
  });
  if (!found) { console.log('  ❌ Custom field selector not found'); return null; }

  await page.evaluate(() => {
    const placeholders = Array.from(document.querySelectorAll('[class*="placeholder"]'));
    const cf = placeholders.find(p => p.innerText?.toLowerCase().includes('custom field') || p.innerText?.toLowerCase().includes('select any'));
    if (cf) cf.closest('[class*="control"]')?.click();
  });
  await new Promise(r => setTimeout(r, 1200));

  // Type keyword to filter
  await page.keyboard.type(keyword, { delay: 50 });
  await new Promise(r => setTimeout(r, 1000));

  // Get visible options
  const opts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
  );
  console.log(`  Options for "${keyword}":`, opts);

  if (opts.length === 0) {
    // Try clearing and searching broader
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 800));
    const opts2 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
    );
    console.log(`  All options:`, opts2.slice(0, 15));
    await page.keyboard.press('Escape');
    return null;
  }

  // Click first matching option
  const clicked = await page.evaluate((kw) => {
    const opts = Array.from(document.querySelectorAll('.disco-select__option'));
    const m = opts.find(o => o.innerText.toLowerCase().includes(kw.toLowerCase()));
    if (m) { m.click(); return m.innerText.trim(); }
    if (opts[0]) { opts[0].click(); return opts[0].innerText.trim(); }
    return null;
  }, keyword);
  console.log(`  Clicked: "${clicked}"`);

  await new Promise(r => setTimeout(r, 1200));

  // Dump what inputs appeared
  const newFields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea,select')).map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, className: el.className.substring(0, 80),
      visible: el.offsetParent !== null
    }))
  );
  return { clicked, newFields };
}

(async () => {
  const cookies = JSON.parse(process.env.REFRENS_COOKIES);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));

  const token = await waitForToken(page);
  console.log('[PROBE] Token:', token ? '✅' : '❌');

  await page.evaluateOnNewDocument(t => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, token);
  await page.goto(CRM_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate(t => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, token);
  await new Promise(r => setTimeout(r, 2500));

  console.log('\n[PROBE] URL:', page.url());

  // ── Baseline: all fields before adding any custom field ──────────────────
  const baseline = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea')).map(el => el.name || el.id).filter(n => n)
  );
  console.log('\n[BASELINE FIELDS]', baseline);

  // ── Stage options: click the stage disco-select directly ─────────────────
  console.log('\n[STAGE PROBE] Clicking Stage dropdown (index 3)...');
  const controls = await page.$$('.disco-select__control');
  console.log(`  Total disco-select controls: ${controls.length}`);
  if (controls[3]) {
    await controls[3].click();
    await new Promise(r => setTimeout(r, 2000));
    const stageOpts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
    );
    console.log(`  Stage options (${stageOpts.length}):`, stageOpts);
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Pipeline options: click the pipeline disco-select ────────────────────
  console.log('\n[PIPELINE PROBE] Clicking Pipeline dropdown (index 2)...');
  const controls2 = await page.$$('.disco-select__control');
  if (controls2[2]) {
    await controls2[2].click();
    await new Promise(r => setTimeout(r, 2000));
    const pipeOpts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
    );
    console.log(`  Pipeline options (${pipeOpts.length}):`, pipeOpts);
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Get all custom field options ─────────────────────────────────────────
  console.log('\n[CUSTOM FIELDS] Getting all available options...');

  // Scroll to Custom Fields section
  await page.evaluate(() => {
    const allText = Array.from(document.querySelectorAll('*'));
    const cfSection = allText.find(e => e.textContent?.trim() === 'Custom Fields' && e.children.length < 3);
    if (cfSection) cfSection.scrollIntoView({ behavior: 'instant', block: 'center' });
  });
  await new Promise(r => setTimeout(r, 500));

  // Find and click the custom field selector
  const cfClicked = await page.evaluate(() => {
    // Look for a control containing "select any custom field" placeholder or "Add Custom Fields"
    const allEls = Array.from(document.querySelectorAll('*'));
    const cf = allEls.find(e => {
      const t = (e.innerText || '').trim().toLowerCase();
      return (t === 'select any custom field' || t === 'add custom fields') && e.children.length < 5;
    });
    if (cf) {
      const ctrl = cf.closest('[class*="control"]') || cf.closest('[class*="select"]') || cf;
      ctrl.click();
      return cf.innerText.trim();
    }
    // Try finding any remaining placeholder
    const placeholders = Array.from(document.querySelectorAll('[class*="placeholder"]'));
    const last = placeholders.find(p => {
      const t = (p.innerText||'').toLowerCase();
      return t.includes('custom') || t.includes('select any');
    });
    if (last) {
      last.closest('[class*="control"]')?.click();
      return last.innerText.trim();
    }
    return null;
  });
  console.log(`  CF selector clicked: "${cfClicked}"`);
  await new Promise(r => setTimeout(r, 1500));

  const allCfOpts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.disco-select__option')).map(o => o.innerText.trim())
  );
  console.log(`\n[ALL CUSTOM FIELD OPTIONS] (${allCfOpts.length} total):`);
  allCfOpts.forEach((o,i) => console.log(`  [${i}] "${o}"`));
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));

  // ── Add phone_number custom field and dump resulting input ─────────────────
  console.log('\n[ADDING phone_number custom field]');
  const r1 = await selectCustomField(page, 'phone_number');
  if (r1) {
    const newOnes = r1.newFields.filter(f => !baseline.includes(f.name) && !baseline.includes(f.id));
    console.log('  NEW fields after adding phone_number:', newOnes.map(f => `name="${f.name}" id="${f.id}" type="${f.type}" visible=${f.visible}`));
  }

  // ── Add timeline custom field ─────────────────────────────────────────────
  console.log('\n[ADDING timeline custom field]');
  const r2 = await selectCustomField(page, 'when_would');
  if (r2) {
    const newOnes = r2.newFields.filter(f => !baseline.includes(f.name) && !baseline.includes(f.id));
    console.log('  NEW fields after adding timeline:', newOnes.map(f => `name="${f.name}" id="${f.id}" type="${f.type}" visible=${f.visible}`));
  }

  // ── Add insurance custom field ─────────────────────────────────────────────
  console.log('\n[ADDING insurance custom field]');
  const r3 = await selectCustomField(page, 'medical_insurance');
  if (r3) {
    const newOnes = r3.newFields.filter(f => !baseline.includes(f.name) && !baseline.includes(f.id));
    console.log('  NEW fields after adding insurance:', newOnes.map(f => `name="${f.name}" id="${f.id}" type="${f.type}" visible=${f.visible}`));
  }

  // ── Dump all inputs at the end ─────────────────────────────────────────────
  const finalFields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea,select')).map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, visible: el.offsetParent !== null
    })).filter(f => f.visible || f.name)
  );
  console.log('\n[FINAL ALL FIELDS]:');
  finalFields.forEach((f,i) => console.log(`  [${i}] <${f.tag}> type="${f.type}" name="${f.name}" id="${f.id}" placeholder="${f.placeholder.substring(0,50)}" visible=${f.visible}`));

  await page.screenshot({ path: '/Users/jaskiring/Relive cure v2/custom-fields-probe.png', fullPage: true });
  console.log('\n[PROBE] Screenshot: custom-fields-probe.png');

  await browser.close();
  console.log('[PROBE] Done ✅');
})().catch(e => { console.error('[PROBE] Fatal:', e); process.exit(1); });
