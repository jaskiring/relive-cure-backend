import puppeteer from 'puppeteer';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REFRENS_URL = 'https://www.refrens.com/app/relivecure/leads';

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

async function waitForTokenRefresh(page, timeoutMs = 20000) {
    await page.goto('https://www.refrens.com/app', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
        await page.waitForFunction(() => {
            const at = sessionStorage.getItem('__at');
            return !!at && at.length > 20;
        }, { timeout: timeoutMs, polling: 300 });
        return true;
    } catch (_) { return false; }
}

function looksLikeCsv(text) {
    if (!text || text.length < 100) return false;
    const lines = text.split('\n').filter(l => l.trim());
    return lines.length > 3 && lines[0].includes(',') && lines[1].includes(',');
}

export async function syncRefrensLeads(supabaseAdmin) {
    console.log('[REFRENS SYNC] ▶ Starting v7c...');
    const startTime = Date.now();
    let browser = null;
    let capturedCsvText = null;

    try {
        const cookiesRaw = process.env.REFRENS_COOKIES;
        if (!cookiesRaw) return { success: false, error: 'REFRENS_COOKIES env var missing' };

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            defaultViewport: { width: 1366, height: 768 }
        });

        const page = await browser.newPage();

        // ── Auth ──
        const cookies = JSON.parse(cookiesRaw);
        await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));

        const tokenReady = await waitForTokenRefresh(page, 15000);
        const capturedToken = tokenReady ? await page.evaluate(() => sessionStorage.getItem('__at')) : null;
        if (capturedToken) {
            console.log('[REFRENS SYNC] __at token ready ✅');
        } else {
            console.warn('[REFRENS SYNC] Token exchange failed — cookies only');
        }

        // ── Intercept ALL network responses (before navigation) ──
        page.on('response', async (response) => {
            if (capturedCsvText) return;
            try {
                const url = response.url();
                const status = response.status();
                const ct = (response.headers()['content-type'] || '').toLowerCase();
                const cd = (response.headers()['content-disposition'] || '').toLowerCase();

                // Log anything export/download related for debugging
                if (url.includes('export') || url.includes('download') || url.includes('csv') || ct.includes('csv') || cd.includes('csv') || cd.includes('attachment')) {
                    console.log(`[REFRENS SYNC] 🔍 Response ${status} ct="${ct}" cd="${cd}" url=${url.slice(0, 120)}`);
                }

                if (status === 200 && (ct.includes('csv') || ct.includes('text/plain') || cd.includes('csv') || cd.includes('attachment'))) {
                    const text = await response.text();
                    if (looksLikeCsv(text)) {
                        capturedCsvText = text;
                        console.log(`[REFRENS SYNC] ✅ CSV via network response (${text.length} bytes)`);
                    }
                }
            } catch (_) {}
        });

        // ── Expose CSV capture to page ──
        await page.exposeFunction('__onCsvText__', (text) => {
            if (!capturedCsvText && looksLikeCsv(text)) {
                capturedCsvText = text;
                console.log(`[REFRENS SYNC] ✅ CSV via page intercept (${text.length} bytes)`);
            }
        });

        // ── Navigate to leads page ──
        if (capturedToken) {
            await page.evaluateOnNewDocument((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken);
        }
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        if (capturedToken) {
            await page.evaluate((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken).catch(() => {});
        }

        if (page.url().includes('/login') || page.url().includes('/signin')) {
            await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES' };
        }

        await page.waitForSelector('table, [class*="lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[REFRENS SYNC] Page: "${await page.title()}" @ ${page.url().slice(0, 80)}`);

        // ── Inject fetch + blob interceptors into page ──
        await page.evaluate(() => {
            // Blob interceptor
            const origCreateObjectURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = function(blob) {
                try {
                    const reader = new FileReader();
                    reader.onloadend = () => { if (reader.result) window.__onCsvText__(reader.result); };
                    reader.readAsText(blob);
                } catch(_) {}
                return origCreateObjectURL(blob);
            };

            // Fetch interceptor — captures CSV from any fetch response
            const origFetch = window.fetch.bind(window);
            window.fetch = async function(...args) {
                const resp = await origFetch(...args);
                try {
                    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                    const ct = resp.headers.get('content-type') || '';
                    const cd = resp.headers.get('content-disposition') || '';
                    if (ct.includes('csv') || cd.includes('csv') || cd.includes('attachment') || url.includes('download') || url.includes('export')) {
                        const clone = resp.clone();
                        clone.text().then(t => window.__onCsvText__(t)).catch(() => {});
                    }
                } catch(_) {}
                return resp;
            };
        }).catch(() => {});

        // ── Step 1: Click "Download CSV" button ──
        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            const btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv')
                     || els.find(e => (e.getAttribute('title')||'').toLowerCase().includes('download csv'))
                     || els.find(e => e.textContent?.trim().toLowerCase().includes('download csv'));
            if (btn) { btn.click(); return btn.tagName + ':' + btn.textContent?.trim().slice(0, 30); }
            return null;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }
        console.log(`[REFRENS SYNC] Step 1 clicked: "${clicked}"`);

        // ── Step 2: Poll for modal + click Download button ──
        // Uses setInterval so frame errors don't crash the whole flow
        let modalClicked = false;
        const tryClickModal = setInterval(async () => {
            if (capturedCsvText || modalClicked) { clearInterval(tryClickModal); return; }
            try {
                const result = await page.evaluate(() => {
                    const bodyText = (document.body?.innerText || '').toLowerCase();
                    if (!bodyText.includes('ready to download') && !bodyText.includes('file is ready')) return 'waiting';

                    // Re-apply blob interceptor in case it was wiped
                    if (!window.__blobInterceptorActive__) {
                        window.__blobInterceptorActive__ = true;
                        const orig = URL.createObjectURL.bind(URL);
                        URL.createObjectURL = function(blob) {
                            try { const r = new FileReader(); r.onloadend = () => window.__onCsvText__(r.result); r.readAsText(blob); } catch(_) {}
                            return orig(blob);
                        };
                    }

                    const btns = [...document.querySelectorAll('button, a')];
                    const dlBtn = btns.find(b => {
                        const t = b.textContent?.trim().toLowerCase();
                        return t === 'download' || t === 'download file' || t === 'download leads';
                    });
                    if (dlBtn) { dlBtn.click(); return 'clicked:' + dlBtn.textContent?.trim(); }

                    // Fallback: any button in modal/dialog
                    const modal = document.querySelector('[class*="modal"],[class*="dialog"],[role="dialog"]');
                    if (modal) {
                        const btn = [...modal.querySelectorAll('button,a')].find(b => !b.textContent?.toLowerCase().includes('cancel') && !b.textContent?.toLowerCase().includes('close'));
                        if (btn) { btn.click(); return 'fallback:' + btn.textContent?.trim(); }
                    }
                    return 'modal_found_no_btn';
                });

                if (result && result.startsWith('clicked')) {
                    console.log(`[REFRENS SYNC] Step 2: ${result}`);
                    modalClicked = true;
                    clearInterval(tryClickModal);
                } else if (result && result !== 'waiting') {
                    console.log(`[REFRENS SYNC] Modal state: ${result}`);
                }
            } catch (_) {
                // Frame might be detached during navigation — keep trying
            }
        }, 2000);

        // ── Wait up to 120s for CSV capture ──
        const maxWait = 120000;
        const waitStart = Date.now();
        while (!capturedCsvText && Date.now() - waitStart < maxWait) {
            await new Promise(r => setTimeout(r, 1000));
            if ((Date.now() - waitStart) % 15000 < 1000) {
                console.log(`[REFRENS SYNC] Waiting... ${Math.round((Date.now()-waitStart)/1000)}s | modalClicked=${modalClicked} | url=${page.url().slice(0,60)}`);
            }
        }
        clearInterval(tryClickModal);

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        if (!capturedCsvText) {
            return { success: false, error: `CSV not captured after ${maxWait/1000}s. modalClicked=${modalClicked}` };
        }

        // ── Parse & upsert ──
        const content = capturedCsvText.replace(/^﻿/, '');
        let rows;
        try {
            rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        } catch (e) {
            return { success: false, error: `CSV parse error: ${e.message} | preview: ${content.slice(0, 100)}` };
        }

        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows | cols: ${JSON.stringify(Object.keys(rows[0] || {})).slice(0, 150)}`);

        const mapped = rows.map(mapRow).filter(Boolean);
        const deduped = Object.values(mapped.reduce((acc, r) => { acc[r.id] = r; return acc; }, {}));
        console.log(`[REFRENS SYNC] ${deduped.length} unique valid rows`);

        let upserted = 0, errors = 0;
        for (let i = 0; i < deduped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(deduped.slice(i, i + 100), { onConflict: 'id' });
            if (error) { console.error('[REFRENS SYNC] Upsert error:', error.message); errors++; }
            else upserted += Math.min(100, deduped.length - i);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted, ${errors} errors`);
        return { success: true, total_rows: rows.length, valid_rows: deduped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message };
    }
}
