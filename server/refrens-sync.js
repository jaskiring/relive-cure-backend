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

function isCsvContent(str) {
    if (!str || str.length < 10) return false;
    // Strip BOM if present
    const s = str.replace(/^﻿/, '').trimStart();
    // CSV starts with a printable character (letter, quote, or digit)
    return /^[\w"']/.test(s);
}

function isStaticAssetUrl(url) {
    return /\.(woff2?|ttf|otf|eot|svg|png|jpg|jpeg|gif|ico|js|css|webp|mp4|mp3|pdf)(\?|$)/i.test(url);
}

export async function syncRefrensLeads(supabaseAdmin) {
    console.log('[REFRENS SYNC] ▶ Starting...');
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

        // Apply cookies
        try {
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);
            console.log('[REFRENS SYNC] Cookies applied ✅');
        } catch (e) {
            console.warn('[REFRENS SYNC] Cookie parse error:', e.message);
        }

        // Navigate
        console.log('[REFRENS SYNC] Navigating to Refrens leads page...');
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
            await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES in Railway' };
        }

        await page.waitForSelector('table, [class*="lead"], [class*="Lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));

        console.log(`[REFRENS SYNC] Page ready: "${await page.title()}"`);

        // ── Intercept the XHR/fetch that the Download CSV button triggers ────
        // We intercept AFTER navigation is complete — strictly filter out static assets
        let csvContent = null;

        const csvPromise = new Promise((resolve) => {
            let done = false;

            // Watch for new tabs (some apps open a blank page for download)
            browser.on('targetcreated', async (target) => {
                if (done || target.type() !== 'page') return;
                try {
                    const newPage = await target.page();
                    if (!newPage) return;
                    // Wait for any response on new page
                    newPage.on('response', async (res) => {
                        if (done) return;
                        const ct = res.headers()['content-type'] || '';
                        const cd = res.headers()['content-disposition'] || '';
                        if ((ct.includes('csv') || cd.includes('attachment') || cd.includes('.csv')) && !isStaticAssetUrl(res.url())) {
                            try {
                                const str = (await res.buffer()).toString('utf-8');
                                if (isCsvContent(str)) {
                                    console.log(`[REFRENS SYNC] New-tab CSV ✅ (${str.length} chars)`);
                                    done = true; resolve(str);
                                }
                            } catch {}
                        }
                    });
                } catch {}
            });

            // Watch page responses — ONLY after button click (started below)
            page._csvResolve = (str) => { if (!done) { done = true; resolve(str); } };
        });

        // Set up strict post-click response listener
        const responseHandler = async (response) => {
            if (!page._listenForCsv) return; // Only active after click
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            const cd = response.headers()['content-disposition'] || '';
            const status = response.status();

            // Skip static assets
            if (isStaticAssetUrl(url)) return;
            // Skip non-2xx
            if (status < 200 || status >= 300) return;
            // Skip HTML, images, fonts, scripts
            if (/text\/html|image\/|font\/|application\/javascript|text\/javascript|text\/css/.test(ct)) return;

            // Accept if content-type or URL or content-disposition suggests CSV/download
            const looksLikeCsv = ct.includes('csv') || ct.includes('octet-stream') || ct.includes('text/plain') ||
                                  cd.includes('attachment') || cd.includes('.csv') ||
                                  url.includes('.csv') || url.toLowerCase().includes('export') || url.toLowerCase().includes('download');

            if (!looksLikeCsv) return;

            try {
                const buf = await response.buffer();
                const str = buf.toString('utf-8');
                if (isCsvContent(str)) {
                    console.log(`[REFRENS SYNC] CSV intercepted: ${url.slice(0, 80)} (${str.length} chars)`);
                    console.log(`[REFRENS SYNC] First 100 chars: ${str.slice(0, 100)}`);
                    page._csvResolve(str);
                } else {
                    console.log(`[REFRENS SYNC] Skipped binary response from: ${url.slice(0, 80)}`);
                }
            } catch (e) {
                console.warn('[REFRENS SYNC] Buffer error:', e.message);
            }
        };
        page.on('response', responseHandler);

        // Click the button
        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            let btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (!btn) btn = els.find(e => e.textContent?.trim().toLowerCase() === 'export csv');
            if (!btn) btn = els.find(e => {
                const t = (e.getAttribute('title') || '').toLowerCase();
                return t === 'download csv' || t === 'export csv';
            });
            if (btn) { btn.click(); return btn.textContent?.trim().slice(0, 40); }
            return null;
        });

        if (!clicked) {
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }

        console.log(`[REFRENS SYNC] Clicked: "${clicked}" — now listening for CSV response...`);
        page._listenForCsv = true; // Enable listener NOW (after click)

        // Wait up to 90s
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CSV response not received within 90s')), 90000)
        );

        try {
            csvContent = await Promise.race([csvPromise, timeoutPromise]);
        } catch (err) {
            // Last resort: check if page navigated to a CSV URL
            const finalUrl = page.url();
            console.log('[REFRENS SYNC] Timeout — final URL:', finalUrl);
            const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            if (isCsvContent(bodyText)) {
                csvContent = bodyText;
                console.log('[REFRENS SYNC] Got CSV from page body');
            } else {
                await browser.close();
                return { success: false, error: err.message };
            }
        }

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        // Parse
        const content = csvContent.replace(/^﻿/, '');
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
        console.log(`[REFRENS SYNC] Parsed ${rows.length} rows`);

        const mapped = rows.map(mapRow).filter(Boolean);
        console.log(`[REFRENS SYNC] ${mapped.length} valid rows (${rows.length - mapped.length} skipped)`);

        let upserted = 0, errors = 0;
        for (let i = 0; i < mapped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(mapped.slice(i, i + 100), { onConflict: 'id' });
            if (error) { console.error(`[REFRENS SYNC] Batch error:`, error.message); errors++; }
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
