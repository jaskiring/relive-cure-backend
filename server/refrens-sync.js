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
    const phone = normalizePhone(getField(row, 'Phone', 'phone_number', 'phone') || '');
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
        insurance: getField(row, "do_you_have_medical_insurance_", "do_you_have_medical_insurance?", "do_you_have_health_insurance_"),
        timeline: getField(row,
            "when_would_you_prefer_to_undergo_the_lasik_treatment?",
            "when_are_you_planning_for_lasik?",
            "when_are_you_looking_to_get_lasik_consultation?"
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
    console.log('[REFRENS SYNC] ▶ Starting v4...');
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

        // ── STRATEGY 1: Intercept blob URL creation (handles JS-generated downloads) ──
        // Inject BEFORE page loads so it catches the overridden function
        await page.evaluateOnNewDocument(() => {
            window.__refrens_csv = null;
            window.__refrens_csv_status = 'waiting';

            const origCreateObjectURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = function(obj) {
                const blobUrl = origCreateObjectURL(obj);
                if (obj instanceof Blob && obj.size > 500) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const text = e.target.result || '';
                        // Check if this looks like CSV data (has commas and newlines)
                        if (text.includes(',') && (text.includes('\n') || text.includes('\r'))) {
                            window.__refrens_csv = text;
                            window.__refrens_csv_status = 'captured';
                            console.log('[BLOB INTERCEPTOR] CSV captured, size:', text.length);
                        }
                    };
                    reader.readAsText(obj);
                }
                return blobUrl;
            };
        });

        // ── STRATEGY 2: Network response interception as backup ──
        // Set flag BEFORE click to avoid race condition, but filter carefully
        let networkCsvContent = null;
        let networkListenActive = false;

        page.on('response', async (response) => {
            if (!networkListenActive) return;
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            const cd = response.headers()['content-disposition'] || '';
            const status = response.status();

            if (status < 200 || status >= 300) return;
            // Skip static assets
            if (/\.(woff2?|ttf|otf|eot|svg|png|jpg|jpeg|gif|ico|webp|mp4|mp3|pdf)(\?|$)/i.test(url)) return;
            // Skip HTML/scripts/styles
            if (/text\/html|application\/javascript|text\/javascript|text\/css|image\//i.test(ct)) return;

            // Only capture if it's clearly CSV or download
            const isCsvLike = ct.includes('csv') || ct.includes('octet-stream') ||
                              cd.includes('attachment') || cd.includes('.csv') ||
                              url.toLowerCase().includes('export') || url.toLowerCase().includes('.csv');
            if (!isCsvLike) return;

            try {
                const buf = await response.buffer();
                const str = buf.toString('utf-8').replace(/^﻿/, '');
                // Validate: must have commas + newlines in first 300 chars (real CSV structure)
                const sample = str.slice(0, 300);
                if (sample.includes(',') && (sample.includes('\n') || sample.includes('\r'))) {
                    console.log(`[REFRENS SYNC] Network CSV captured: ${url.slice(0, 80)} (${str.length} chars)`);
                    console.log(`[REFRENS SYNC] First 120 chars: ${str.slice(0, 120)}`);
                    networkCsvContent = str;
                }
            } catch (e) {
                console.warn('[REFRENS SYNC] Response buffer error:', e.message);
            }
        });

        // Apply cookies
        try {
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);
            console.log('[REFRENS SYNC] Cookies applied ✅');
        } catch (e) {
            console.warn('[REFRENS SYNC] Cookie parse error:', e.message);
        }

        console.log('[REFRENS SYNC] Navigating...');
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
            await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES' };
        }

        await page.waitForSelector('table, [class*="lead"], [class*="Lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[REFRENS SYNC] Page ready: "${await page.title()}"`);

        // Enable network listener BEFORE click
        networkListenActive = true;

        // Click the Download CSV button
        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            let btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (!btn) btn = els.find(e => (e.getAttribute('title') || '').toLowerCase() === 'download csv');
            if (btn) { btn.click(); return btn.textContent?.trim().slice(0, 40); }
            return null;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }
        console.log(`[REFRENS SYNC] Clicked: "${clicked}"`);

        // Poll for up to 60s — check both blob interceptor and network capture
        let csvContent = null;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));

            // Check Strategy 1: blob interceptor
            const blobResult = await page.evaluate(() => ({
                csv: window.__refrens_csv,
                status: window.__refrens_csv_status
            })).catch(() => ({ csv: null, status: 'error' }));

            if (blobResult.csv && blobResult.csv.length > 100) {
                console.log(`[REFRENS SYNC] ✅ Strategy 1 (blob): ${blobResult.csv.length} chars at poll ${i + 1}`);
                csvContent = blobResult.csv;
                break;
            }

            // Check Strategy 2: network interception
            if (networkCsvContent && networkCsvContent.length > 100) {
                console.log(`[REFRENS SYNC] ✅ Strategy 2 (network): ${networkCsvContent.length} chars at poll ${i + 1}`);
                csvContent = networkCsvContent;
                break;
            }

            if ((i + 1) % 5 === 0) console.log(`[REFRENS SYNC] Polling... ${(i + 1) * 2}s`);
        }

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        if (!csvContent) {
            return { success: false, error: 'Could not capture CSV after 60s — both blob and network strategies failed' };
        }

        // Parse CSV
        const content = csvContent.replace(/^﻿/, '');
        let rows;
        try {
            rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        } catch (parseErr) {
            console.error('[REFRENS SYNC] Parse error:', parseErr.message);
            console.log('[REFRENS SYNC] First 300 chars of content:', content.slice(0, 300));
            return { success: false, error: `CSV parse error: ${parseErr.message}` };
        }

        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows`);

        // Log column names from first row to help debug phone field
        if (rows.length > 0) {
            const cols = Object.keys(rows[0]);
            console.log('[REFRENS SYNC] Columns:', JSON.stringify(cols));
            console.log('[REFRENS SYNC] Sample row phone fields:', JSON.stringify({
                Phone: rows[0]['Phone'],
                phone: rows[0]['phone'],
                phone_number: rows[0]['phone_number'],
                'Contact Name': rows[0]['Contact Name']
            }));
        }

        const mapped = rows.map(mapRow).filter(Boolean);
        console.log(`[REFRENS SYNC] ${mapped.length} valid rows (${rows.length - mapped.length} skipped — no phone)`);

        if (mapped.length === 0 && rows.length > 0) {
            // Log first row to diagnose phone issue
            console.log('[REFRENS SYNC] First row full:', JSON.stringify(rows[0]).slice(0, 400));
        }

        let upserted = 0, errors = 0;
        for (let i = 0; i < mapped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(mapped.slice(i, i + 100), { onConflict: 'id' });
            if (error) { console.error(`[REFRENS SYNC] Upsert error:`, error.message); errors++; }
            else upserted += Math.min(100, mapped.length - i);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted, ${errors} errors`);
        return { success: true, total_rows: rows.length, valid_rows: mapped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message };
    }
}
