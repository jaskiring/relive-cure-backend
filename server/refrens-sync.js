import puppeteer from 'puppeteer';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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

    let browser = null;
    let csvContent = null;

    try {
        const cookiesRaw = process.env.REFRENS_COOKIES;
        if (!cookiesRaw) return { success: false, error: 'REFRENS_COOKIES env var missing' };

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            defaultViewport: { width: 1366, height: 768 }
        });

        const page = await browser.newPage();

        // ── Strategy 1: Intercept CSV response in-memory ──────────────────────
        // Some Refrens buttons trigger a new page/tab for the download
        // We intercept at the browser level by watching all targets

        // Set up network response interception on the current page
        const csvPromise = new Promise((resolve) => {
            const handler = async (response) => {
                const url = response.url();
                const ct = response.headers()['content-type'] || '';
                const cd = response.headers()['content-disposition'] || '';
                if (
                    ct.includes('text/csv') ||
                    ct.includes('application/csv') ||
                    ct.includes('application/octet-stream') ||
                    cd.includes('.csv') ||
                    url.includes('.csv') ||
                    url.includes('export') ||
                    url.includes('download')
                ) {
                    try {
                        const buf = await response.buffer();
                        console.log(`[REFRENS SYNC] CSV response intercepted: ${url.slice(0, 80)} (${buf.length} bytes)`);
                        resolve(buf.toString('utf-8'));
                    } catch (e) {
                        console.warn('[REFRENS SYNC] Failed to buffer CSV response:', e.message);
                    }
                }
            };
            page.on('response', handler);
        });

        // Also watch for new tabs (some apps open a new page for download)
        const newPageCsvPromise = new Promise((resolve) => {
            browser.on('targetcreated', async (target) => {
                if (target.type() === 'page') {
                    try {
                        const newPage = await target.page();
                        if (!newPage) return;
                        newPage.on('response', async (response) => {
                            const ct = response.headers()['content-type'] || '';
                            const cd = response.headers()['content-disposition'] || '';
                            if (ct.includes('csv') || cd.includes('.csv') || ct.includes('octet-stream')) {
                                try {
                                    const buf = await response.buffer();
                                    console.log(`[REFRENS SYNC] New-tab CSV: ${response.url().slice(0, 80)} (${buf.length} bytes)`);
                                    resolve(buf.toString('utf-8'));
                                } catch {}
                            }
                        });
                    } catch {}
                }
            });
        });

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

        // Log page title and URL to confirm we're in the right place
        const pageTitle = await page.title();
        console.log(`[REFRENS SYNC] Page: "${pageTitle}" | URL: ${page.url().slice(0, 80)}`);

        // ── Strategy: Find the download button with multiple approaches ─────
        const btnInfo = await page.evaluate(() => {
            const allEls = [...document.querySelectorAll('button,a,span,div,li,svg')];
            const candidates = allEls
                .filter(e => {
                    const text = e.textContent?.trim().toLowerCase() || '';
                    const title = (e.getAttribute('title') || '').toLowerCase();
                    const aria = (e.getAttribute('aria-label') || '').toLowerCase();
                    return text === 'download csv' || text === 'export' || text === 'export csv' ||
                        title.includes('download') || aria.includes('download') ||
                        title.includes('export') || aria.includes('export');
                })
                .map(e => ({
                    tag: e.tagName,
                    text: e.textContent?.trim().slice(0, 50),
                    title: e.getAttribute('title'),
                    classes: e.className?.slice?.(0, 60),
                    visible: e.offsetParent !== null
                }));
            return candidates;
        });
        console.log('[REFRENS SYNC] Download button candidates:', JSON.stringify(btnInfo));

        const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,a,span,div,li')];
            // Try exact text match first
            let btn = els.find(e => e.textContent?.trim().toLowerCase() === 'download csv');
            if (!btn) btn = els.find(e => e.textContent?.trim().toLowerCase() === 'export csv');
            if (!btn) btn = els.find(e => e.textContent?.trim().toLowerCase() === 'export');
            if (!btn) btn = els.find(e => {
                const t = (e.getAttribute('title') || '').toLowerCase();
                return t.includes('download') || t.includes('export');
            });
            if (btn) { btn.click(); return btn.textContent?.trim().slice(0, 40); }
            return null;
        });

        if (!clicked) {
            // Log the full page HTML structure to help debug
            const structure = await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button')].map(b => b.textContent?.trim().slice(0, 40));
                const links = [...document.querySelectorAll('a')].map(a => a.textContent?.trim().slice(0, 40)).filter(Boolean);
                return { buttons: btns.slice(0, 20), links: links.slice(0, 20) };
            });
            console.log('[REFRENS SYNC] Page buttons:', JSON.stringify(structure.buttons));
            console.log('[REFRENS SYNC] Page links:', JSON.stringify(structure.links));
            await browser.close();
            return { success: false, error: 'Download CSV button not found — check logs for page structure' };
        }

        console.log(`[REFRENS SYNC] Clicked: "${clicked}"`);

        // Wait up to 90s for CSV response from either strategy
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CSV response timeout after 90s')), 90000)
        );

        try {
            csvContent = await Promise.race([csvPromise, newPageCsvPromise, timeoutPromise]);
            console.log(`[REFRENS SYNC] CSV captured in memory ✅ (${csvContent.length} chars)`);
        } catch (timeoutErr) {
            // Strategy 2 fallback: maybe the page navigated to a CSV URL directly
            const finalUrl = page.url();
            if (finalUrl.includes('.csv') || finalUrl.includes('export')) {
                console.log('[REFRENS SYNC] Trying direct page content as CSV...');
                const content = await page.content();
                if (content && !content.includes('<html')) {
                    csvContent = content;
                }
            }
            if (!csvContent) {
                await browser.close();
                return { success: false, error: timeoutErr.message };
            }
        }

        await browser.close();
        browser = null;
        console.log('[REFRENS SYNC] Browser closed ✅');

        // Parse CSV
        const content = csvContent.replace(/^﻿/, ''); // strip BOM
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

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[REFRENS SYNC] ✅ Done in ${duration}s — ${upserted} upserted, ${errors} batch errors`);

        return { success: true, total_rows: rows.length, valid_rows: mapped.length, upserted, errors, duration_seconds: duration, synced_at: new Date().toISOString() };

    } catch (err) {
        console.error('[REFRENS SYNC] ❌ Fatal:', err.message);
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message };
    }
}
