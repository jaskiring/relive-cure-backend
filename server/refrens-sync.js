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

export async function syncRefrensLeads(supabaseAdmin) {
    console.log('[REFRENS SYNC] ▶ Starting v7b (two-step modal + blob/network intercept)...');
    const startTime = Date.now();
    let browser = null;

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
            await page.evaluateOnNewDocument((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken);
        } else {
            console.warn('[REFRENS SYNC] Token exchange failed — continuing with cookies only');
        }

        // ── CSV capture storage (shared between handlers) ──
        let capturedCsvText = null;

        // ── Method 1: Intercept network responses ──
        page.on('response', async (response) => {
            if (capturedCsvText) return;
            try {
                const ct = response.headers()['content-type'] || '';
                const url = response.url();
                if (ct.includes('csv') || ct.includes('text/plain') || url.includes('export') || url.includes('download') || url.includes('/csv')) {
                    const text = await response.text();
                    if (text && text.length > 200 && text.split('\n').length > 3 && text.includes(',')) {
                        capturedCsvText = text;
                        console.log(`[REFRENS SYNC] ✅ CSV via network (${text.length} bytes): ${url.slice(0, 80)}`);
                    }
                }
            } catch (_) {}
        });

        // ── Method 2: Blob interceptor ──
        await page.exposeFunction('__onCsvBlob__', (text) => {
            if (!capturedCsvText && text && text.length > 200 && text.split('\n').length > 3) {
                capturedCsvText = text;
                console.log(`[REFRENS SYNC] ✅ CSV via blob (${text.length} bytes)`);
            }
        });

        const injectBlobInterceptor = async () => {
            try {
                await page.evaluate(() => {
                    if (window.__blobInterceptorActive__) return;
                    window.__blobInterceptorActive__ = true;
                    const orig = URL.createObjectURL.bind(URL);
                    URL.createObjectURL = function(blob) {
                        try {
                            const reader = new FileReader();
                            reader.onloadend = () => { if (reader.result) window.__onCsvBlob__(reader.result); };
                            reader.readAsText(blob);
                        } catch(_) {}
                        return orig(blob);
                    };
                });
            } catch(_) {}
        };

        // ── Navigate to leads page ──
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        if (capturedToken) {
            await page.evaluate((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken);
        }

        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
            await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES' };
        }

        await page.waitForSelector('table, [class*="lead"], [class*="Lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[REFRENS SYNC] Page: "${await page.title()}"`);

        await injectBlobInterceptor();

        // ── Step 1: Click "Download CSV" ──
        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            let btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (!btn) btn = els.find(e => (e.getAttribute('title') || '').toLowerCase().includes('download csv'));
            if (!btn) btn = els.find(e => e.textContent?.trim().toLowerCase().includes('download csv'));
            if (btn) { btn.click(); return btn.tagName + ':' + btn.textContent?.trim().slice(0, 30); }
            return null;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }
        console.log(`[REFRENS SYNC] Step 1 clicked: "${clicked}"`);

        // ── Step 2: Wait for "ready to download" modal (up to 90s) ──
        console.log('[REFRENS SYNC] Waiting for file-ready modal...');
        try {
            await page.waitForFunction(
                () => document.body.innerText.toLowerCase().includes('ready to download') ||
                      document.body.innerText.toLowerCase().includes('file is ready'),
                { timeout: 90000, polling: 1500 }
            );
            console.log('[REFRENS SYNC] ✅ Modal ready — clicking Download button...');

            await injectBlobInterceptor(); // re-inject in case frame refreshed

            // Click the Download button in modal
            const modalBtnClicked = await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button, a')];
                const dlBtn = btns.find(b => {
                    const t = b.textContent?.trim().toLowerCase();
                    return t === 'download' || t === 'download file' || t === 'download leads';
                });
                if (dlBtn) { dlBtn.click(); return dlBtn.textContent?.trim(); }
                // Try any button inside a modal/dialog
                const modal = document.querySelector('[class*="modal"], [class*="dialog"], [role="dialog"]');
                if (modal) {
                    const anyBtn = modal.querySelector('button');
                    if (anyBtn) { anyBtn.click(); return 'fallback:' + anyBtn.textContent?.trim(); }
                }
                return null;
            }).catch(() => null);

            console.log(`[REFRENS SYNC] Modal btn: "${modalBtnClicked}"`);

        } catch (modalErr) {
            console.warn('[REFRENS SYNC] Modal wait:', modalErr.message);
            // CSV might already be captured via network response
        }

        // ── Wait up to 15s for CSV capture ──
        const captureStart = Date.now();
        while (!capturedCsvText && Date.now() - captureStart < 15000) {
            await new Promise(r => setTimeout(r, 500));
        }

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        if (!capturedCsvText) {
            return { success: false, error: 'CSV not captured — modal or download mechanism may have changed' };
        }

        // ── Parse ──
        const content = capturedCsvText.replace(/^﻿/, '');
        let rows;
        try {
            rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        } catch (e) {
            return { success: false, error: `CSV parse error: ${e.message}` };
        }

        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows, columns: ${JSON.stringify(Object.keys(rows[0] || {}))}`);

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
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted`);
        return { success: true, total_rows: rows.length, valid_rows: deduped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message };
    }
}
