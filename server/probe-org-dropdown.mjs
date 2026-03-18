/**
 * Deep DOM probe — find the REAL org dropdown selector
 * Dumps all interactive elements that look like dropdowns/selects
 */
import puppeteer from 'puppeteer';
import 'dotenv/config';

const CRM_FORM_URL = process.env.CRM_FORM_URL || 'https://www.refrens.com/app/relivecure/leads/new';
const USER_DATA_DIR = './session';

(async () => {
  const browser = await puppeteer.launch({
    headless: true, userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.goto(CRM_FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Probe ALL possible dropdown-like elements
  const probe = await page.evaluate(() => {
    const result = {};

    // 1. All role attributes in page
    result.allRoles = [...new Set(
      Array.from(document.querySelectorAll('[role]')).map(el => el.getAttribute('role'))
    )];

    // 2. react-select containers (common pattern)
    result.reactSelectContainers = Array.from(
      document.querySelectorAll('[class*="react-select"][class*="container"]')
    ).map((el, i) => ({
      index: i,
      classes: el.className,
      inputId: el.querySelector('input')?.id || '',
      currentValue: el.querySelector('[class*="singleValue"], [class*="placeholder"]')?.innerText?.trim() || ''
    }));

    // 3. react-select controls (clickable area)
    result.reactSelectControls = Array.from(
      document.querySelectorAll('[class*="react-select"][class*="control"]')
    ).map((el, i) => ({
      index: i,
      classes: el.className.split(' ').filter(c => c.includes('react-select')).join(' '),
      currentValue: el.querySelector('[class*="singleValue"], [class*="placeholder"]')?.innerText?.trim() || ''
    }));

    // 4. elements with aria-haspopup
    result.ariaHaspopup = Array.from(document.querySelectorAll('[aria-haspopup]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      ariaHaspopup: el.getAttribute('aria-haspopup'),
      classes: el.className.substring(0, 80),
      text: el.innerText?.trim().substring(0, 40) || ''
    }));

    // 5. elements with aria-expanded
    result.ariaExpanded = Array.from(document.querySelectorAll('[aria-expanded]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      ariaExpanded: el.getAttribute('aria-expanded'),
      classes: el.className.substring(0, 80),
      text: el.innerText?.trim().substring(0, 40) || ''
    }));

    return result;
  });

  console.log('\n═══ ALL ROLES ON PAGE ═══');
  console.log(probe.allRoles.join(', '));

  console.log('\n═══ REACT-SELECT CONTAINERS ═══');
  probe.reactSelectContainers.forEach(c =>
    console.log(`[${c.index}] inputId="${c.inputId}" value="${c.currentValue}" class="${c.classes.substring(0,80)}..."`)
  );

  console.log('\n═══ REACT-SELECT CONTROLS (clickable) ═══');
  probe.reactSelectControls.forEach(c =>
    console.log(`[${c.index}] class="${c.classes}" value="${c.currentValue}"`)
  );

  console.log('\n═══ aria-haspopup ELEMENTS ═══');
  probe.ariaHaspopup.forEach(e =>
    console.log(`  <${e.tag}> role="${e.role}" aria-haspopup="${e.ariaHaspopup}" text="${e.text}"`)
  );

  console.log('\n═══ aria-expanded ELEMENTS ═══');
  probe.ariaExpanded.forEach(e =>
    console.log(`  <${e.tag}> role="${e.role}" aria-expanded="${e.ariaExpanded}" text="${e.text}"`)
  );

  // Now: click the FIRST react-select control, wait for options, log them
  console.log('\n═══ CLICKING FIRST REACT-SELECT CONTROL ═══');
  const firstControl = await page.$('[class*="react-select"][class*="control"]');
  if (firstControl) {
    await firstControl.click();
    await new Promise(r => setTimeout(r, 1200));

    const options = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[class*="react-select"][class*="option"], [id*="react-select"][id*="option"]')).map(el => ({
        text: el.innerText.trim(),
        id: el.id,
        classes: el.className.substring(0, 60)
      }));
    });
    console.log(`Options found after click: ${options.length}`);
    options.forEach((o, i) => console.log(`  [${i}] id="${o.id}" text="${o.text}"`));

    await page.screenshot({ path: 'org-dropdown-open.png', fullPage: true });
    console.log('Screenshot: org-dropdown-open.png');
  } else {
    console.log('No react-select control found!');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
