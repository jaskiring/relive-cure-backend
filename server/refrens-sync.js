import puppeteer from 'puppeteer';
import { parse } from 'csv-parse/sync';

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
    const phone = normalizePhone(getField(row, 'Phone', 'phone_number', 'phone', 'Mobile', 'mobile', 'Phone Number', 'Contact Phone') || '');
    if (!phone) return null;
    return {
        id: phone, contact_name: getField(row, 'Contact Name', 'Name', 'name'),
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

// Same token exchange as crm-automation.js
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
    console.log('[REFRENS SYNC] ▶ Starting v5...');
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

        // Apply cookies (same as crm-automation.js)
        const cookies = JSON.parse(cookiesRaw);
        await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));
        console.log('[REFRENS SYNC] Cookies applied ✅');

        // Step 1: Exchange __rt for __at (same as crm-automation.js)
        const tokenReady = await waitForTokenRefresh(page, 15000);
        if (!tokenReady) {
            await browser.close();
            return { success: false, error: 'Token refresh failed — __at not found in sessionStorage' };
        }
        const capturedToken = await page.evaluate(() => sessionStorage.getItem('__at'));
        console.log(`[REFRENS SYNC] Got __at token ✅ (len=${capturedToken?.length})`);

        // Persist token for next navigation
        await page.evaluateOnNewDocument((token) => {
            try { sessionStorage.setItem('__at', token); } catch(e) {}
        }, capturedToken);

        // Step 2: Enable request interception to capture ALL post-click requests
        await page.setRequestInterception(true);

        const postClickRequests = [];
        let captureActive = false;
        let csvContent = null;

        page.on('request', (request) => {
            if (captureActive) {
                const url = request.url();
                if (!url.match(/\.(woff2?|ttf|png|jpg|gif|ico|svg|webp)(\?|$)/i)) {
                    postClickRequests.push({ url, method: request.method() });
                }
            }
            request.continue();
        });

        page.on('response', async (response) => {
            if (!captureActive) return;
            const url = response.url();
            if (url.match(/\.(woff2?|ttf|png|jpg|gif|ico|svg|webp|js|css)(\?|$)/i)) return;
            const ct = response.headers()['content-type'] || '';
            const cd = response.headers()['content-disposition'] || '';
            const status = response.status();
            if (status < 200 || status >= 300) return;

            // Capture: text/csv, octet-stream with attachment, or URL has csv/export
            const isDownload = ct.includes('text/csv') || ct.includes('application/csv') ||
                               (ct.includes('octet-stream') && (cd.includes('attachment') || cd.includes('.csv'))) ||
                               cd.toLowerCase().includes('.csv') ||
                               url.toLowerCase().includes('/csv') || url.toLowerCase().includes('export');

            if (!isDownload) return;

            try {
                const buf = await response.buffer();
                const str = buf.toString('utf-8').replace(/^﻿/, '');
                const sample = str.slice(0, 300);
                if (sample.includes(',') && (sample.includes('\n') || sample.includes('\r'))) {
                    console.log(`[REFRENS SYNC] ✅ Network CSV: ${url.slice(0, 100)}`);
                    console.log(`[REFRENS SYNC] Content-Type: ${ct} | CD: ${cd}`);
                    console.log(`[REFRENS SYNC] First 200 chars: ${str.slice(0, 200)}`);
                    csvContent = str;
                }
            } catch (e) {
                console.warn('[REFRENS SYNC] Response buffer error:', e.message);
            }
        });

        // Step 3: Navigate to leads page
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.evaluate((token) => {
            try { sessionStorage.setItem('__at', token); } catch(e) {}
        }, capturedToken);

        await page.waitForSelector('table, [class*="lead"], [class*="Lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[REFRENS SYNC] Leads page ready: "${await page.title()}"`);

        // Step 4: Click button with request capture active
        captureActive = true;

        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            let btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (!btn) btn = els.find(e => (e.getAttribute('title') || '').toLowerCase() === 'download csv');
            if (btn) { btn.click(); return btn.tagName + ': ' + btn.textContent?.trim().slice(0, 40); }
            return null;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }
        console.log(`[REFRENS SYNC] Clicked: "${clicked}"`);

        // Step 5: Wait 30s and check what requests were made
        await new Promise(r => setTimeout(r, 5000));
        console.log(`[REFRENS SYNC] Post-click requests (5s): ${JSON.stringify(postClickRequests.slice(-10))}`);

        // Wait up to 30 more seconds for CSV
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            if (csvContent) break;
            if (i === 4) console.log('[REFRENS SYNC] All post-click requests so far:', JSON.stringify(postClickRequests));
        }

        // Step 6: If network didn't get it, try direct API with __at token
        if (!csvContent) {
            console.log('[REFRENS SYNC] Network capture failed. Trying direct API fetch with __at...');
            console.log('[REFRENS SYNC] All post-click requests:', JSON.stringify(postClickRequests));

            // Try to fetch the CSV directly using the __at token via page.evaluate
            const result = await page.evaluate(async (token) => {
                // Common Refrens export API patterns
                const attempts = [
                    { url: '/api/v2/leads/export?businessSlug=relivecure&format=csv', headers: { 'x-at': token, 'Authorization': `Bearer ${token}` } },
                    { url: '/api/v1/leads/export?businessSlug=relivecure&format=csv', headers: { 'x-at': token } },
                    { url: '/api/leads/download?format=csv', headers: { 'x-at': token } },
                ];
                const logs = [];
                for (const attempt of attempts) {
                    try {
                        const res = await fetch(attempt.url, { headers: attempt.headers, credentials: 'include' });
                        const ct = res.headers.get('content-type') || '';
                        const text = await res.text();
                        logs.push(`${attempt.url} -> ${res.status} ${ct} (${text.length}c)`);
                        if (res.ok && text.includes(',') && text.includes('\n')) {
                            return { csv: text, log: logs };
                        }
                    } catch(e) {
                        logs.push(`${attempt.url} -> ERROR: ${e.message}`);
                    }
                }
                return { csv: null, log: logs };
            }, capturedToken);

            console.log('[REFRENS SYNC] Direct API attempts:', JSON.stringify(result.log));
            if (result.csv) {
                console.log(`[REFRENS SYNC] ✅ Direct API CSV: ${result.csv.length} chars`);
                csvContent = result.csv;
            }
        }

        await browser.close();
        browser = null;

        if (!csvContent) {
            return { success: false, error: 'All strategies failed. Check logs for post-click request URLs to find the correct API endpoint.' };
        }

        const content = csvContent.replace(/^﻿/, '');
        let rows;
        try {
            rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        } catch (e) {
            console.error('[REFRENS SYNC] Parse error:', e.message);
            console.log('[REFRENS SYNC] First 300 chars:', content.slice(0, 300));
            return { success: false, error: `CSV parse error: ${e.message}` };
        }

        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows`);
        if (rows.length > 0) {
            const cols = Object.keys(rows[0]);
            console.log('[REFRENS SYNC] Columns:', JSON.stringify(cols));
            console.log('[REFRENS SYNC] First row sample:', JSON.stringify(rows[0]).slice(0, 400));
        }

        const mapped = rows.map(mapRow).filter(Boolean);
        console.log(`[REFRENS SYNC] ${mapped.length} valid rows`);

        let upserted = 0, errors = 0;
        for (let i = 0; i < mapped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(mapped.slice(i, i + 100), { onConflict: 'id' });
            if (error) { console.error('[REFRENS SYNC] Upsert error:', error.message); errors++; }
            else upserted += Math.min(100, mapped.length - i);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted`);
        return { success: true, total_rows: rows.length, valid_rows: mapped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message };
    }
}
