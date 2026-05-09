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
    console.log('[REFRENS SYNC] ▶ Starting v7d...');
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
        console.log(`[REFRENS SYNC] Auth: token=${capturedToken ? 'OK' : 'missing'}`);

        // ── Network response interceptor ──
        page.on('response', async (response) => {
            if (capturedCsvText) return;
            try {
                const url = response.url();
                const ct = (response.headers()['content-type'] || '').toLowerCase();
                const cd = (response.headers()['content-disposition'] || '').toLowerCase();
                if (cd.includes('attachment') || ct.includes('csv') || url.includes('/export') || url.includes('/download')) {
                    console.log(`[REFRENS SYNC] 📡 ${response.status()} ct="${ct.slice(0,40)}" cd="${cd.slice(0,60)}" ${url.slice(0,100)}`);
                    if (response.status() === 200) {
                        const text = await response.text();
                        if (looksLikeCsv(text)) {
                            capturedCsvText = text;
                            console.log(`[REFRENS SYNC] ✅ CSV via network (${text.length}b)`);
                        }
                    }
                }
            } catch (_) {}
        });

        // ── Expose CSV capture ──
        await page.exposeFunction('__onCsvText__', (text) => {
            if (!capturedCsvText && looksLikeCsv(text)) {
                capturedCsvText = text;
                console.log(`[REFRENS SYNC] ✅ CSV via page hook (${text.length}b)`);
            }
        });

        // ── Navigate ──
        if (capturedToken) {
            await page.evaluateOnNewDocument((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken);
        }
        await page.goto(REFRENS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        if (capturedToken) await page.evaluate((t) => { try { sessionStorage.setItem('__at', t); } catch(e) {} }, capturedToken).catch(() => {});

        if (page.url().includes('/login')) {
            await browser.close();
            return { success: false, error: 'Session expired — update REFRENS_COOKIES' };
        }

        await page.waitForSelector('table, [class*="lead"]', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[REFRENS SYNC] Page ready: "${await page.title()}"`);

        // ── Inject fetch + blob interceptors ──
        await page.evaluate(() => {
            // Blob interceptor
            const origURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = function(blob) {
                try { const r = new FileReader(); r.onloadend = () => window.__onCsvText__(r.result); r.readAsText(blob); } catch(_) {}
                return origURL(blob);
            };
            // Fetch interceptor
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

        // ── Find "Download CSV" element via Puppeteer handle (native click) ──
        const downloadHandle = await page.evaluateHandle(() => {
            const els = [...document.querySelectorAll('button, a, span, div')];
            return els.find(e => e.textContent?.trim().toLowerCase() === 'download csv')
                || els.find(e => (e.getAttribute('title') || '').toLowerCase().includes('download csv'))
                || els.find(e => e.textContent?.trim().toLowerCase().includes('download csv'));
        });

        const downloadEl = downloadHandle?.asElement();
        if (!downloadEl) {
            // Debug: show page content
            const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500));
            console.log('[REFRENS SYNC] Page text sample:', pageText);
            await browser.close();
            return { success: false, error: 'Download CSV button not found' };
        }

        // Scroll into view + native Puppeteer click (real mouse events)
        await downloadEl.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
        await new Promise(r => setTimeout(r, 500));
        await downloadEl.click();  // Real mouse events — triggers React handlers
        console.log('[REFRENS SYNC] Step 1: native click fired ✅');

        // ── Poll for modal + click Download (interval, frame-error safe) ──
        let modalClicked = false;
        const tryModal = setInterval(async () => {
            if (capturedCsvText || modalClicked) { clearInterval(tryModal); return; }
            try {
                // Log body snippet for debugging
                const snippet = await page.evaluate(() => {
                    const t = document.body?.innerText || '';
                    // Return anything modal-like
                    const lower = t.toLowerCase();
                    if (lower.includes('ready') || lower.includes('preparing') || lower.includes('download')) {
                        return t.slice(0, 200);
                    }
                    return null;
                });
                if (snippet) console.log(`[REFRENS SYNC] Body: ${snippet.replace(/\n/g,' ').slice(0,120)}`);

                const result = await page.evaluate(() => {
                    const body = (document.body?.innerText || '').toLowerCase();
                    if (!body.includes('ready to download') && !body.includes('file is ready')) return 'waiting';

                    // Re-inject blob interceptor
                    const orig = URL.createObjectURL.bind(URL);
                    URL.createObjectURL = function(blob) {
                        try { const r = new FileReader(); r.onloadend = () => window.__onCsvText__(r.result); r.readAsText(blob); } catch(_) {}
                        return orig(blob);
                    };

                    // Find Download button
                    const btns = [...document.querySelectorAll('button, a')];
                    const dlBtn = btns.find(b => {
                        const t = b.textContent?.trim().toLowerCase();
                        return t === 'download' || t === 'download file' || t === 'download leads';
                    });
                    if (dlBtn) { dlBtn.click(); return 'clicked:' + dlBtn.textContent?.trim(); }

                    // Fallback: modal button that isn't cancel/close
                    const modal = document.querySelector('[class*="modal"],[class*="dialog"],[role="dialog"],[class*="Modal"],[class*="Dialog"]');
                    if (modal) {
                        const btn = [...modal.querySelectorAll('button,a')]
                            .find(b => !/(cancel|close|dismiss)/i.test(b.textContent));
                        if (btn) { btn.click(); return 'fallback:' + btn.textContent?.trim().slice(0,20); }
                    }
                    return 'modal_found_no_btn';
                });

                if (result && result !== 'waiting') {
                    console.log(`[REFRENS SYNC] Modal: ${result}`);
                    if (result.startsWith('clicked') || result.startsWith('fallback')) {
                        modalClicked = true;
                        clearInterval(tryModal);
                    }
                }
            } catch(_) {}
        }, 3000);

        // ── Wait up to 120s ──
        const maxWait = 120000;
        const waitStart = Date.now();
        while (!capturedCsvText && Date.now() - waitStart < maxWait) {
            await new Promise(r => setTimeout(r, 1000));
            if ((Date.now() - waitStart) % 20000 < 1000) {
                console.log(`[REFRENS SYNC] Elapsed: ${Math.round((Date.now()-waitStart)/1000)}s | modal=${modalClicked}`);
            }
        }
        clearInterval(tryModal);

        await browser.close(); browser = null;
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
            return { success: false, error: `Parse error: ${e.message} | preview: ${content.slice(0,80)}` };
        }

        console.log(`[REFRENS SYNC] ${rows.length} rows | cols: ${JSON.stringify(Object.keys(rows[0]||{})).slice(0,120)}`);

        const mapped = rows.map(mapRow).filter(Boolean);
        const deduped = Object.values(mapped.reduce((acc, r) => { acc[r.id] = r; return acc; }, {}));

        let upserted = 0, errors = 0;
        for (let i = 0; i < deduped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(deduped.slice(i, i + 100), { onConflict: 'id' });
            if (error) { errors++; console.error('[REFRENS SYNC] Upsert:', error.message); }
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
