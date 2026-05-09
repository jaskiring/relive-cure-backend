import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOWNLOAD_DIR = path.join(__dirname, '../tmp_refrens');
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
    const phone = normalizePhone(getField(row, 'Phone', 'phone_number') || '');
    if (!phone) return null;
    return {
        id: phone,
        contact_name: getField(row, 'Contact Name'),
        phone,
        customer_city: getField(row, 'Customer City'),
        state: getField(row, 'State'),
        refrens_created_at: parseRefrensDate(row['Created At']),
        status: getField(row, 'Status'),
        lead_source: getField(row, 'Lead Source'),
        assignee: getField(row, 'Assignee'),
        follow_up_date: getField(row, 'Follow up date'),
        last_comment_by: getField(row, 'Last comment by'),
        first_response_time: getField(row, 'First Response Time'),
        last_internal_note: getField(row, 'Last Internal Note'),
        next_activity: getField(row, 'Next Activity'),
        date_closed: getField(row, 'Date Closed'),
        whatsapp_link: getField(row, 'Whatsapp Link'),
        lead_description: getField(row, 'Lead Description'),
        labels: getField(row, 'Labels'),
        duplicate: getField(row, 'Duplicate'),
        call_outcome: getField(row, 'Call Outcome'),
        consultation_status: getField(row, 'Consultation Status'),
        lead_state: getField(row, 'Lead State'),
        intent_band: getField(row, 'Intent Band'),
        intent_score: getField(row, 'Intent Score'),
        objection_type: getField(row, 'Objection Type'),
        eye_power: getField(row, "what_is_your_current_eye_power?", "what's_your_eye_power?"),
        insurance: getField(row, "do_you_have_medical_insurance_", "do_you_have_medical_insurance?", "do_you_have_health_insurance_", "do_you_have_insurance?"),
        timeline: getField(row,
            "when_would_you_prefer_to_undergo_the_lasik_treatment?",
            "when_are_you_planning_for_lasik?",
            "when_are_you_looking_to_get_lasik_consultation?",
            "when_are_you_planning_for_lasik_in_special_offer_of_₹24999/-_"
        ),
        city_preference: getField(row,
            "kindly_choose_the_city_where_you_wish_to_avail_the_treatment",
            "which_city_would_you_prefer_for_treatment_"
        ),
        last_user_message: getField(row, 'last_user_message'),
        lead_type: getField(row, 'lead_type'),
        parameters_completed: getField(row, 'parameters_completed'),
        reason_for_lasik: getField(row, "what_is_the_main_reason_you're_considering_lasik_surgery?"),
        age: getField(row, "what's_your_age?"),
        glasses_problem: getField(row,
            "what's_the_biggest_problem_you_face_while_using_glasses_or_contact_lenses_?👀🤔_",
            "what's_the_biggest_problem_you_face_while_using_glasses_or_contact_lenses_?👀🤔"
        ),
        synced_at: new Date().toISOString(),
        raw_data: row
    };
}

export async function syncRefrensLeads(supabaseAdmin) {
    console.log('[REFRENS SYNC] ▶ Starting...');
    const startTime = Date.now();

    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    try { fs.readdirSync(DOWNLOAD_DIR).forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f))); } catch {}

    let browser = null;
    let downloadedFile = null;

    try {
        const cookiesRaw = process.env.REFRENS_COOKIES;
        if (!cookiesRaw) return { success: false, error: 'REFRENS_COOKIES env var missing' };

        // ISOLATED browser — no shared state with crm-automation.js
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            defaultViewport: { width: 1366, height: 768 }
        });

        const page = await browser.newPage();

        const client = await page.createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });

        try {
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);
            console.log('[REFRENS SYNC] Cookies applied ✅');
        } catch (e) {
            console.warn('[REFRENS SYNC] Cookie parse error:', e.message);
        }

        console.log('[REFRENS SYNC] Navigating to Refrens leads page...');
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
            await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES in Railway' };
        }

        await page.waitForSelector('table, [class*="lead"], [class*="Lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));

        console.log('[REFRENS SYNC] Clicking Download CSV...');
        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            const btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (btn) { btn.click(); return true; }
            return false;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found on page' };
        }

        console.log('[REFRENS SYNC] Waiting for download...');
        const MAX_WAIT = 180000;
        let elapsed = 0;
        while (elapsed < MAX_WAIT) {
            await new Promise(r => setTimeout(r, 4000));
            elapsed += 4000;
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.csv') && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
            if (files.length > 0) {
                downloadedFile = path.join(DOWNLOAD_DIR, files[0]);
                const kb = (fs.statSync(downloadedFile).size / 1024).toFixed(1);
                console.log(`[REFRENS SYNC] Downloaded: ${files[0]} (${kb} KB) ✅`);
                break;
            }
            if (elapsed % 20000 === 0) console.log(`[REFRENS SYNC] Waiting... ${elapsed / 1000}s`);
        }

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        if (!downloadedFile) return { success: false, error: 'Download timed out after 3 minutes' };

        const content = fs.readFileSync(downloadedFile, 'utf-8').replace(/^﻿/, '');
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows`);

        const mapped = rows.map(mapRow).filter(Boolean);
        console.log(`[REFRENS SYNC] ${mapped.length} valid rows (${rows.length - mapped.length} skipped — no phone)`);

        let upserted = 0, errors = 0;
        const BATCH = 100;
        for (let i = 0; i < mapped.length; i += BATCH) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(mapped.slice(i, i + BATCH), { onConflict: 'id' });
            if (error) { console.error(`[REFRENS SYNC] Batch ${i} error:`, error.message); errors++; }
            else upserted += Math.min(BATCH, mapped.length - i);
        }

        fs.unlinkSync(downloadedFile);
        downloadedFile = null;
        try { fs.readdirSync(DOWNLOAD_DIR).forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f))); } catch {}

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted, ${errors} batch errors`);

        return { success: true, total_rows: rows.length, valid_rows: mapped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (browser) await browser.close().catch(() => {});
        if (downloadedFile && fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
        try { fs.readdirSync(DOWNLOAD_DIR).forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f))); } catch {}
        return { success: false, error: err.message };
    }
}
