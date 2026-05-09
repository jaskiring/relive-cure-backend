import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DOWNLOAD_DIR = path.join(__dirname, '../tmp_dl');

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
        await page.waitForFunction(() => !!sessionStorage.getItem('__at')?.length > 20, { timeout: timeoutMs, polling: 300 });
        return true;
    } catch (_) { return false; }
}

export async function syncRefrensLeads(supabaseAdmin) {
    console.log('[REFRENS SYNC] ▶ Starting v6...');
    const startTime = Date.now();
    let browser = null;

    // Clean download dir
    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    try { fs.readdirSync(DOWNLOAD_DIR).forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f))); } catch {}

    try {
        const cookiesRaw = process.env.REFRENS_COOKIES;
        if (!cookiesRaw) return { success: false, error: 'REFRENS_COOKIES env var missing' };

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            defaultViewport: { width: 1366, height: 768 }
        });

        // ── BROWSER-LEVEL CDP: catches ALL downloads regardless of mechanism ──
        const browserSession = await browser.target().createCDPSession();
        await browserSession.send('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: DOWNLOAD_DIR,
            eventsEnabled: true
        });
        console.log(`[REFRENS SYNC] Download dir: ${DOWNLOAD_DIR}`);

        let downloadGuid = null;
        let downloadFilename = null;
        let downloadComplete = false;

        browserSession.on('Browser.downloadWillBegin', (event) => {
            downloadGuid = event.guid;
            downloadFilename = event.suggestedFilename || 'leads.csv';
            console.log(`[REFRENS SYNC] ⬇ Download starting: "${downloadFilename}" from ${event.url?.slice(0, 80)}`);
        });

        browserSession.on('Browser.downloadProgress', (event) => {
            if (event.guid === downloadGuid) {
                console.log(`[REFRENS SYNC] Download: ${event.state} ${event.receivedBytes}/${event.totalBytes} bytes`);
                if (event.state === 'completed') downloadComplete = true;
                if (event.state === 'canceled') console.warn('[REFRENS SYNC] Download canceled!');
            }
        });

        const page = await browser.newPage();

        // Apply cookies + token exchange (same as crm-automation.js)
        const cookies = JSON.parse(cookiesRaw);
        await page.setCookie(...cookies.filter(c => c.name && c.value && c.domain));

        const tokenReady = await waitForTokenRefresh(page, 15000);
        const capturedToken = tokenReady ? await page.evaluate(() => sessionStorage.getItem('__at')) : null;
        if (capturedToken) {
            console.log(`[REFRENS SYNC] __at token ready ✅`);
            await page.evaluateOnNewDocument((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken);
        } else {
            console.warn('[REFRENS SYNC] Token exchange failed — continuing with cookies only');
        }

        // Navigate to leads page
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
        console.log(`[REFRENS SYNC] Page ready: "${await page.title()}"`);

        // Click Download CSV
        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            let btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (!btn) btn = els.find(e => (e.getAttribute('title') || '').toLowerCase() === 'download csv');
            if (btn) { btn.click(); return btn.tagName + ':' + btn.textContent?.trim().slice(0,30); }
            return null;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }
        console.log(`[REFRENS SYNC] Clicked: "${clicked}"`);

        // Wait up to 90s for download to complete
        const maxWait = 90000;
        const pollInterval = 2000;
        let waited = 0;
        let downloadedFile = null;

        while (waited < maxWait) {
            await new Promise(r => setTimeout(r, pollInterval));
            waited += pollInterval;

            // Check via CDP download events
            if (downloadComplete && downloadGuid) {
                // File is saved as GUID in the download dir
                const guidFile = path.join(DOWNLOAD_DIR, downloadGuid);
                const namedFile = path.join(DOWNLOAD_DIR, downloadFilename);
                if (fs.existsSync(guidFile)) { downloadedFile = guidFile; break; }
                if (fs.existsSync(namedFile)) { downloadedFile = namedFile; break; }
            }

            // Also scan the directory for any CSV file
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f =>
                !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.endsWith('.part')
            );
            if (files.length > 0) {
                const fullPath = path.join(DOWNLOAD_DIR, files[0]);
                const stat = fs.statSync(fullPath);
                if (stat.size > 100) {
                    downloadedFile = fullPath;
                    console.log(`[REFRENS SYNC] File found: ${files[0]} (${stat.size} bytes)`);
                    break;
                }
            }

            if (waited % 10000 === 0) console.log(`[REFRENS SYNC] Waiting for download... ${waited/1000}s`);
        }

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        if (!downloadedFile) {
            return { success: false, error: `Download did not complete in ${maxWait/1000}s. downloadGuid=${downloadGuid} downloadComplete=${downloadComplete}` };
        }

        const content = fs.readFileSync(downloadedFile, 'utf-8').replace(/^﻿/, '');
        try { fs.unlinkSync(downloadedFile); } catch {}

        let rows;
        try {
            rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        } catch (e) {
            console.error('[REFRENS SYNC] Parse error:', e.message, '| First 200:', content.slice(0, 200));
            return { success: false, error: `CSV parse error: ${e.message}` };
        }

        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows`);
        if (rows.length > 0) {
            console.log('[REFRENS SYNC] Columns:', JSON.stringify(Object.keys(rows[0])));
            console.log('[REFRENS SYNC] Row 0 sample:', JSON.stringify(rows[0]).slice(0, 300));
        }

        const mapped = rows.map(mapRow).filter(Boolean);
        console.log(`[REFRENS SYNC] ${mapped.length} valid rows (${rows.length - mapped.length} skipped)`);

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
        try { fs.readdirSync(DOWNLOAD_DIR).forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f))); } catch {}
        return { success: false, error: err.message };
    }
}
