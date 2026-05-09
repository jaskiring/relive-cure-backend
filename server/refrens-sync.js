import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Reuse the SAME browser instance as crm-automation.js
// (persistent userDataDir profile — the one Refrens already trusts)
import { getBrowserCookies } from './crm-automation.js';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REFRENS_URL = 'https://www.refrens.com/app/relivecure/leads';
const USER_DATA_DIR = process.env.PUPPETEER_SESSION_DIR || "./puppeteer-session";

function normalizePhone(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[\s\t\+\-\(\)]/g, '');
    if (cleaned.startsWith('91') && cleaned.length === 12) return cleaned.slice(2);
    if (cleaned.length < 7) return null;
    return cleaned;
}
function parseRefrensDate(str) {
    if (!str || str.trim() === '-' || str.trim() === '') return null;
    try { return new Date(str).toISOString(); } catch { return null; }
}
function getField(row, ...keys) {
    for (const k of keys) {
        const v = row[k];
        if (v && v.trim && v.trim() && v.trim() !== '-') return v.trim();
    }
    return null;
}
function mapRow(row) {
    const phone = normalizePhone(getField(row, 'Phone', 'phone_number', 'phone', 'Mobile', 'Phone Number') || '');
    if (!phone) return null;
    return {
        id: phone, contact_name: getField(row, 'Contact Name', 'Name'),
        phone, customer_city: getField(row, 'Customer City', 'City'),
        state: getField(row, 'State'), refrens_created_at: parseRefrensDate(row['Created At']),
        status: getField(row, 'Status'), lead_source: getField(row, 'Lead Source'),
        assignee: getField(row, 'Assignee'), follow_up_date: getField(row, 'Follow up date'),
        last_comment_by: getField(row, 'Last comment by'), first_response_time: getField(row, 'First Response Time'),
        last_internal_note: getField(row, 'Last Internal Note'), next_activity: getField(row, 'Next Activity'),
        date_closed: getField(row, 'Date Closed'), whatsapp_link: getField(row, 'Whatsapp Link'),
        lead_description: getField(row, 'Lead Description'), labels: getField(row, 'Labels'),
        duplicate: getField(row, 'Duplicate'), call_outcome: getField(row, 'Call Outcome'),
        consultation_status: getField(row, 'Consultation Status'), lead_state: getField(row, 'Lead State'),
        intent_band: getField(row, 'Intent Band'), intent_score: getField(row, 'Intent Score'),
        objection_type: getField(row, 'Objection Type'),
        eye_power: getField(row, "what_is_your_current_eye_power?", "what's_your_eye_power?"),
        insurance: getField(row, "do_you_have_medical_insurance_", "do_you_have_medical_insurance?"),
        timeline: getField(row, "when_would_you_prefer_to_undergo_the_lasik_treatment?", "when_are_you_planning_for_lasik?"),
        city_preference: getField(row, "kindly_choose_the_city_where_you_wish_to_avail_the_treatment"),
        last_user_message: getField(row, 'last_user_message'), lead_type: getField(row, 'lead_type'),
        parameters_completed: getField(row, 'parameters_completed'),
        reason_for_lasik: getField(row, "what_is_the_main_reason_you're_considering_lasik_surgery?"),
        age: getField(row, "what's_your_age?"),
        glasses_problem: getField(row, "what's_the_biggest_problem_you_face_while_using_glasses_or_contact_lenses_?👀🤔_"),
        synced_at: new Date().toISOString(), raw_data: row
    };
}

function looksLikeCsv(text) {
    if (!text || text.length < 100) return false;
    const lines = text.split('\n').filter(l => l.trim());
    return lines.length > 3 && lines[0].includes(',') && lines[1].includes(',');
}

async function ensureChrome() {
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/src/.cache/puppeteer';
    const { execSync } = await import('child_process');
    const { default: fs } = await import('fs');
    try {
        const found = execSync(`find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
        if (found && fs.existsSync(found)) return found;
    } catch (e) {}
    try { const p = puppeteer.executablePath(); if (fs.existsSync(p)) return p; } catch (e) {}
    const systemPaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
    for (const p of systemPaths) { if (fs.existsSync(p)) return p; }
    return undefined;
}

export async function syncRefrensLeads(supabaseAdmin) {
    console.log('[REFRENS SYNC] ▶ Starting v8 (persistent userDataDir profile)...');
    const startTime = Date.now();
    let browser = null;
    let context = null;
    let capturedCsvText = null;

    try {
        const cookiesRaw = process.env.REFRENS_COOKIES;
        if (!cookiesRaw) return { success: false, error: 'REFRENS_COOKIES env var missing' };

        // Launch with same config as crm-automation.js — persistent profile Refrens trusts
        const executablePath = await ensureChrome();
        browser = await puppeteer.launch({
            headless: true,
            slowMo: 0,
            ...(executablePath ? { executablePath } : {}),
            userDataDir: USER_DATA_DIR,
            defaultViewport: null,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-gpu', '--disable-software-rasterizer', '--disable-extensions',
                '--disable-background-networking', '--disable-default-apps', '--disable-sync',
                '--disable-translate', '--hide-scrollbars', '--metrics-recording-only',
                '--mute-audio', '--no-first-run', '--safebrowsing-disable-auto-update',
                '--memory-pressure-off', '--js-flags=--max-old-space-size=256',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled'  // hide webdriver flag
            ],
            timeout: 60000
        });

        // Use isolated context (like crm-automation.js does per lead)
        context = await browser.createBrowserContext();
        const page = await context.newPage();

        // Override navigator.webdriver to avoid bot detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Set auth cookies
        const cookies = JSON.parse(cookiesRaw);
        await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));

        // Exchange __rt for __at token (same as crm-automation.js)
        await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: 20000 });
        let capturedToken = null;
        try {
            await page.waitForFunction(() => {
                const at = sessionStorage.getItem('__at');
                return !!at && at.length > 20;
            }, { timeout: 15000, polling: 300 });
            capturedToken = await page.evaluate(() => sessionStorage.getItem('__at'));
            console.log('[REFRENS SYNC] __at token ready ✅');
        } catch (_) {
            console.warn('[REFRENS SYNC] Token exchange failed — cookies only');
        }

        if (capturedToken) {
            await page.evaluateOnNewDocument((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken);
        }

        // ── Intercept CSV via network responses ──
        page.on('response', async (response) => {
            if (capturedCsvText) return;
            try {
                const ct = (response.headers()['content-type'] || '').toLowerCase();
                const cd = (response.headers()['content-disposition'] || '').toLowerCase();
                if (response.status() === 200 && (ct.includes('csv') || cd.includes('csv') || cd.includes('attachment'))) {
                    const text = await response.text();
                    if (looksLikeCsv(text)) {
                        capturedCsvText = text;
                        console.log(`[REFRENS SYNC] ✅ CSV via network (${text.length}b)`);
                    }
                }
            } catch (_) {}
        });

        // ── Intercept CSV via blob/fetch in page ──
        await page.exposeFunction('__onCsvText__', (text) => {
            if (!capturedCsvText && looksLikeCsv(text)) {
                capturedCsvText = text;
                console.log(`[REFRENS SYNC] ✅ CSV via page hook (${text.length}b)`);
            }
        });

        // ── Navigate to leads page ──
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        if (capturedToken) await page.evaluate((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken).catch(() => {});

        if (page.url().includes('/login')) {
            await context.close(); await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES' };
        }

        await page.waitForSelector('table, [class*="lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[REFRENS SYNC] Page: "${await page.title()}"`);

        // Inject blob + fetch interceptors
        await page.evaluate(() => {
            const origURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = function(blob) {
                try { const r = new FileReader(); r.onloadend = () => window.__onCsvText__(r.result); r.readAsText(blob); } catch(_) {}
                return origURL(blob);
            };
            const origFetch = window.fetch.bind(window);
            window.fetch = async function(...args) {
                const resp = await origFetch(...args);
                try {
                    const cd = resp.headers.get('content-disposition') || '';
                    const ct = resp.headers.get('content-type') || '';
                    if (cd.includes('attachment') || ct.includes('csv')) {
                        resp.clone().text().then(t => window.__onCsvText__(t)).catch(() => {});
                    }
                } catch(_) {}
                return resp;
            };
        }).catch(() => {});

        // ── Step 1: Find + click "Download CSV" via real mouse coordinates ──
        const btnPos = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button, a, span, div')];
            const btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv')
                     || els.find(e => (e.getAttribute('title') || '').toLowerCase().includes('download csv'))
                     || els.find(e => e.textContent?.trim().toLowerCase().includes('download csv'));
            if (!btn) return null;
            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
            const rect = btn.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), tag: btn.tagName, text: btn.textContent?.trim().slice(0,30) };
        });

        if (!btnPos) {
            console.log('[REFRENS SYNC] Page text:', await page.evaluate(() => document.body?.innerText?.slice(0,300)));
            await context.close(); await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }

        console.log(`[REFRENS SYNC] Btn: ${btnPos.tag} "${btnPos.text}" @ (${btnPos.x},${btnPos.y})`);
        await new Promise(r => setTimeout(r, 800));
        await page.mouse.click(btnPos.x, btnPos.y);
        console.log('[REFRENS SYNC] Step 1: mouse.click fired ✅');

        // ── Step 2: Poll every 2s for "ready" modal, click Download ──
        let modalClicked = false;
        const tryModal = setInterval(async () => {
            if (capturedCsvText || modalClicked) { clearInterval(tryModal); return; }
            try {
                const btnInfo = await page.evaluate(() => {
                    const body = (document.body?.innerText || '').toLowerCase();
                    if (!body.includes('ready to download') && !body.includes('file is ready')) return null;

                    // Re-inject blob interceptor
                    const orig = URL.createObjectURL.bind(URL);
                    URL.createObjectURL = function(blob) {
                        try { const r = new FileReader(); r.onloadend = () => window.__onCsvText__(r.result); r.readAsText(blob); } catch(_) {}
                        return orig(blob);
                    };

                    const btns = [...document.querySelectorAll('button, a')];
                    const dlBtn = btns.find(b => {
                        const t = b.textContent?.trim().toLowerCase();
                        return t === 'download' || t === 'download file' || t === 'download leads';
                    }) || (() => {
                        const modal = document.querySelector('[class*="modal"],[class*="dialog"],[role="dialog"]');
                        return modal && [...modal.querySelectorAll('button,a')].find(b => !/(cancel|close|dismiss)/i.test(b.textContent));
                    })();

                    if (!dlBtn) return { found: false };
                    dlBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    const rect = dlBtn.getBoundingClientRect();
                    return { found: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), text: dlBtn.textContent?.trim().slice(0,20) };
                });

                if (btnInfo?.found) {
                    console.log(`[REFRENS SYNC] Step 2 modal: "${btnInfo.text}" @ (${btnInfo.x},${btnInfo.y})`);
                    await page.mouse.click(btnInfo.x, btnInfo.y);
                    modalClicked = true;
                    clearInterval(tryModal);
                    console.log('[REFRENS SYNC] Step 2: modal Download clicked ✅');
                } else if (btnInfo !== null) {
                    console.log('[REFRENS SYNC] Modal found, waiting for Download btn...');
                }
            } catch(_) {}
        }, 2000);

        // Wait up to 120s
        const waitStart = Date.now();
        while (!capturedCsvText && Date.now() - waitStart < 120000) {
            await new Promise(r => setTimeout(r, 1000));
            if ((Date.now() - waitStart) % 30000 < 1000) {
                console.log(`[REFRENS SYNC] ${Math.round((Date.now()-waitStart)/1000)}s elapsed | modal=${modalClicked}`);
            }
        }
        clearInterval(tryModal);

        await context.close();
        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        if (!capturedCsvText) {
            return { success: false, error: `CSV not captured after 120s. modalClicked=${modalClicked}` };
        }

        // ── Parse & upsert ──
        const content = capturedCsvText.replace(/^﻿/, '');
        let rows;
        try {
            rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        } catch (e) {
            return { success: false, error: `Parse error: ${e.message}` };
        }

        const mapped = rows.map(mapRow).filter(Boolean);
        const deduped = Object.values(mapped.reduce((acc, r) => { acc[r.id] = r; return acc; }, {}));
        console.log(`[REFRENS SYNC] ${rows.length} rows → ${deduped.length} unique valid`);

        let upserted = 0, errors = 0;
        for (let i = 0; i < deduped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(deduped.slice(i, i+100), { onConflict: 'id' });
            if (error) { errors++; console.error('[REFRENS SYNC] Upsert error:', error.message); }
            else upserted += Math.min(100, deduped.length - i);
        }

        const duration = ((Date.now() - startTime)/1000).toFixed(1);
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted`);
        return { success: true, total_rows: rows.length, valid_rows: deduped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message };
    }
}
