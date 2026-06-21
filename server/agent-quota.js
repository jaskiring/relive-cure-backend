// server/agent-quota.js
// Persists the Gemini free-tier daily counter to Supabase so it survives
// Railway redeploys and crashes. In-memory cache for speed; write-through
// debounced like schedulePersist() in index.js.
//
// Uses a LAZY dynamic import for supabase-admin so the module loads (and unit
// tests run) without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the env.

const DEFAULT_DAILY_CAP = 1200;

let _mem = { date: null, count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
let _writeTimer = null;
let _bootHydrated = false;
let _testCap = null;  // test override; null in production
let _supabase = null; // lazy-loaded
let _dailyExhausted = false; // set true when quota exhausted; resets next day

function _today() { return new Date().toISOString().slice(0, 10); }
function _cap() {
    if (_testCap !== null) return _testCap;
    const n = parseInt(process.env.GEMINI_DAILY_CAP || '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

// Lazy-load supabaseAdmin only when we actually need to read/write.
async function _db() {
    if (_supabase) return _supabase;
    const mod = await import('./supabase-admin.js');
    _supabase = mod.supabaseAdmin;
    return _supabase;
}

// Test-only helpers.
function _setCapForTest(n) { _testCap = n; }
function resetForTest() {
    _mem = { date: _today(), count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
    _writeTimer = null;
    _bootHydrated = true; // skip Supabase hydrate in tests
    _dailyExhausted = false;
}

// Called once on boot to read today's row from Supabase.
export async function hydrateQuota() {
    if (_bootHydrated) return;
    _bootHydrated = true;
    try {
        const today = _today();
        const db = await _db();
        const { data, error } = await db
            .from('agent_quota')
            .select('date, request_count, fallback_count, tokens_prompt, tokens_output, tokens_thinking, tokens_total')
            .eq('date', today)
            .maybeSingle();
        if (error) {
            console.warn('[AGENT-QUOTA] hydrate failed:', error.message);
            return;
        }
        if (data) {
            _mem = {
                date: data.date,
                count: data.request_count || 0,
                fallbacks: data.fallback_count || 0,
                tokens_prompt: data.tokens_prompt || 0,
                tokens_output: data.tokens_output || 0,
                tokens_thinking: data.tokens_thinking || 0,
                tokens_total: data.tokens_total || 0,
            };
            console.log(`[AGENT-QUOTA] hydrated ${_mem.date} → ${_mem.count}/${_cap()} calls, ${_mem.tokens_total} tokens`);
        } else {
            _mem = { date: today, count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
        }
    } catch (e) {
        console.warn('[AGENT-QUOTA] hydrate error:', e.message);
    }
}

export function isUnderQuota() {
    const d = _today();
    if (_mem.date !== d) {
        _mem = { date: d, count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
        _dailyExhausted = false;
    }
    if (_dailyExhausted) return false;
    const under = _mem.count < _cap();
    if (!under) _dailyExhausted = true; // persist for rest of day
    return under;
}

export function tickRequest() {
    const d = _today();
    if (_mem.date !== d) _mem = { date: d, count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
    _mem.count += 1;
    _scheduleWrite();
}

/** Accumulate token counts from Gemini usageMetadata (Google-reported). */
export function tickTokens(usage = {}) {
    const d = _today();
    if (_mem.date !== d) _mem = { date: d, count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
    const prompt = Number(usage.promptTokenCount) || 0;
    const output = Number(usage.candidatesTokenCount) || 0;
    const thinking = Number(usage.thoughtsTokenCount) || 0;
    const total = Number(usage.totalTokenCount) || (prompt + output + thinking);
    _mem.tokens_prompt += prompt;
    _mem.tokens_output += output;
    _mem.tokens_thinking += thinking;
    _mem.tokens_total += total;
    _scheduleWrite();
}

export function tickFallback() {
    const d = _today();
    if (_mem.date !== d) _mem = { date: d, count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
    _mem.fallbacks += 1;
    _scheduleWrite();
}

export function quotaStatus() {
    const d = _today();
    const count = _mem.date === d ? _mem.count : 0;
    const tokens = _mem.date === d ? {
        prompt: _mem.tokens_prompt,
        output: _mem.tokens_output,
        thinking: _mem.tokens_thinking,
        total: _mem.tokens_total,
    } : { prompt: 0, output: 0, thinking: 0, total: 0 };
    return {
        date: d,
        count,
        cap: _cap(),
        fallbacks: _mem.date === d ? _mem.fallbacks : 0,
        remaining: Math.max(0, _cap() - count),
        tokens,
    };
}

function _scheduleWrite() {
    if (_testCap !== null) return;  // don't touch Supabase in tests
    clearTimeout(_writeTimer);
    _writeTimer = setTimeout(_flush, 500);
}

// Flush immediately on process exit so Railway deploys don't lose counts.
async function flushQuota() {
    clearTimeout(_writeTimer);
    if (_testCap !== null) return;
    if (_mem.count === 0 && _mem.fallbacks === 0) return; // nothing to write
    await _flush();
}

// Register shutdown handler once
if (typeof process !== 'undefined' && !process._quotaShutdownRegistered) {
    process._quotaShutdownRegistered = true;
    const shutdown = async () => { await flushQuota(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('beforeExit', () => { _flush(); }); // best-effort
}

async function _flush() {
    try {
        const db = await _db();
        const { error } = await db
            .from('agent_quota')
            .upsert({
                date: _mem.date,
                request_count: _mem.count,
                fallback_count: _mem.fallbacks,
                tokens_prompt: _mem.tokens_prompt,
                tokens_output: _mem.tokens_output,
                tokens_thinking: _mem.tokens_thinking,
                tokens_total: _mem.tokens_total,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'date' });
        if (error) console.warn('[AGENT-QUOTA] write failed:', error.message);
    } catch (e) {
        console.warn('[AGENT-QUOTA] write error:', e.message);
    }
}

export { _setCapForTest, resetForTest };
