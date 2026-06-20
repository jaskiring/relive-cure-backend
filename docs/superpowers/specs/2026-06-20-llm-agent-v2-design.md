# LLM Agent v2 — Design Spec

**Date:** 2026-06-20
**Project:** Relive Cure WhatsApp bot (`relive-cure-backend`)
**Status:** Approved pending implementation
**Production safety:** Ships dark. Zero behavior change until founder flips env vars.

---

## 0. Why this exists

The current bot (`server/index.js`, v6.2-stable) is a ~1500-line regex + state machine. It loops on unexpected inputs, can't answer questions outside its hardcoded KB, and can't hold a natural conversation. We're adding a free-tier Gemini LLM as the primary reply engine, with the rule-based bot as automatic fallback.

A previous session (Opus) built a first cut of this (`server/llm-agent.js`, uncommitted). It got the architecture right but has four real problems this spec fixes:

1. **Quota counter is in-memory** → resets on every Railway redeploy → could silently blow past Gemini's ~1,500/day free cap.
2. **Conversation history is not persisted** → on restart mid-conversation the agent forgets everything and re-greets the lead.
3. **Fallback handoff is untested** → if the agent fails on message #7, the rule-based bot may re-ask things the agent already collected.
4. **No observability** → no way to see what the agent *would* have said before going live.

This spec replaces the Opus implementation with a hardened v2 that survives restarts, shares state cleanly with the fallback, and ships with a shadow mode + test plan.

---

## 1. Architecture (unchanged from Opus cut — sound bones)

Inbound message flow:

```
[1] saveWhatsAppMessage (inbound capture)         ← unchanged
[2] Human-takeover pause check (bot_paused)        ← unchanged, rule-based
[3] Image / media handler                          ← unchanged, rule-based
[4] Safety guards:
    - isNotInterested / opted_out                  ← unchanged, rule-based
    - isDisengaged / isAbusive                     ← unchanged, rule-based
    - checkNameCorrection                          ← unchanged, rule-based
    - isOffTopic                                   ← unchanged, rule-based
[5] Escalation / sales-intent ("call me")          ← unchanged, rule-based, owns callback push
    │
    ▼
[6] LLM AGENT (Gemini 2.5 Flash, free tier)        ← natural conversation
    │  ↳ any failure / timeout / 429 / quota → fall through silently
    ▼
[7] Rule-based state machine                       ← battle-tested fallback
    │
    ▼
sendWhatsAppReply (WhatsApp send + capture)        ← unchanged
sendToAPI → ingestLead → leads_surgery             ← unchanged
```

**The agent never owns:**
- Opt-out / abuse / disengagement (always rule-based — never let an LLM talk a lead out of opting out)
- Explicit "call me" / "talk to human" (always rule-based — owns the callback + push notification path)
- Human takeover (`bot_paused`) (always rule-based)

**The agent owns:**
- Greeting
- Name capture (casual, never a gate)
- City / eye-power / insurance / timeline qualification (natural, conversational)
- Knowledge questions (cost, recovery, pain, safety, eligibility, referral, timeline, location, alternatives)
- Cataract re-routing (the 66-yo bug fix)
- Callback *intent* detection (sets `wants_callback`, then the rule-based callback message + push fires)

---

## 2. Environment variables

```
GEMINI_API_KEY       = <AI Studio key>      # required for agent to do anything
BOT_AGENT_MODE       = shadow | live        # default: shadow (safe)
GEMINI_MODEL         = gemini-2.5-flash     # optional override
GEMINI_DAILY_CAP     = 1200                 # optional, stay under ~1500 free cap
```

**Mode semantics:**

| Mode | Agent runs? | Reply sent to customer |
|------|-------------|------------------------|
| (unset) | No | Rule-based only |
| `shadow` | Yes | **Rule-based** (agent reply is logged only) |
| `live` | Yes | Agent reply (rule-based on fallback) |

`isAgentEnabled()` returns true only when `GEMINI_API_KEY` is set AND `BOT_AGENT_MODE` is `shadow` or `live`.

---

## 3. Files to create / modify

### 3.1 NEW: `server/migrations/create_agent_quota.sql`

```sql
-- Agent free-tier quota counter. Survives Railway redeploys (filesystem is
-- ephemeral; the counter must live in Supabase). One row per UTC day.
--
-- Run once in the Supabase SQL editor.

create table if not exists agent_quota (
  date          date primary key,
  request_count integer not null default 0,
  fallback_count integer not null default 0,   -- times agent failed and rule-based fired
  updated_at    timestamptz not null default now()
);

-- Helpful view for the dashboard: today's usage
create or replace view agent_quota_today as
select date, request_count, fallback_count,
       (select count(*) from agent_quota) > 0 as ever_used
from agent_quota
order by date desc
limit 1;
```

### 3.2 NEW: `server/agent-quota.js`

Pure module: in-memory fast-path + Supabase write-through. No Express routes here.

```javascript
// server/agent-quota.js
// Persists the Gemini free-tier daily counter to Supabase so it survives
// Railway redeploys and crashes. In-memory cache for speed; write-through
// debounced like schedulePersist() in index.js.

import { supabaseAdmin } from './supabase-admin.js';

const DEFAULT_DAILY_CAP = 1200;

let _mem = { date: null, count: 0, fallbacks: 0 };
let _writeTimer = null;
let _bootHydrated = false;

function _today() { return new Date().toISOString().slice(0, 10); }
function _cap() {
    const n = parseInt(process.env.GEMINI_DAILY_CAP || '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

// Called once on boot to read today's row from Supabase.
export async function hydrateQuota() {
    if (_bootHydrated) return;
    _bootHydrated = true;
    try {
        const today = _today();
        const { data, error } = await supabaseAdmin
            .from('agent_quota')
            .select('date, request_count, fallback_count')
            .eq('date', today)
            .maybeSingle();
        if (error) {
            console.warn('[AGENT-QUOTA] hydrate failed:', error.message);
            return;
        }
        if (data) {
            _mem = { date: data.date, count: data.request_count || 0, fallbacks: data.fallback_count || 0 };
            console.log(`[AGENT-QUOTA] hydrated ${_mem.date} → ${_mem.count}/${_cap()}`);
        } else {
            _mem = { date: today, count: 0, fallbacks: 0 };
        }
    } catch (e) {
        console.warn('[AGENT-QUOTA] hydrate error:', e.message);
    }
}

export function isUnderQuota() {
    const d = _today();
    if (_mem.date !== d) _mem = { date: d, count: 0, fallbacks: 0 };
    return _mem.count < _cap();
}

export function tickRequest() {
    const d = _today();
    if (_mem.date !== d) _mem = { date: d, count: 0, fallbacks: 0 };
    _mem.count += 1;
    _scheduleWrite();
}

export function tickFallback() {
    const d = _today();
    if (_mem.date !== d) _mem = { date: d, count: 0, fallbacks: 0 };
    _mem.fallbacks += 1;
    _scheduleWrite();
}

export function quotaStatus() {
    const d = _today();
    const count = _mem.date === d ? _mem.count : 0;
    return { date: d, count, cap: _cap(), fallbacks: _mem.date === d ? _mem.fallbacks : 0 };
}

function _scheduleWrite() {
    clearTimeout(_writeTimer);
    _writeTimer = setTimeout(_flush, 1000);
}

async function _flush() {
    try {
        const { error } = await supabaseAdmin
            .from('agent_quota')
            .upsert({
                date: _mem.date,
                request_count: _mem.count,
                fallback_count: _mem.fallbacks,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'date' });
        if (error) console.warn('[AGENT-QUOTA] write failed:', error.message);
    } catch (e) {
        console.warn('[AGENT-QUOTA] write error:', e.message);
    }
}
```

### 3.3 NEW: `server/llm-agent.js` (REPLACE the Opus version entirely)

Same idea as Opus's, with these changes:
- Import `isUnderQuota, tickRequest, tickFallback` from `./agent-quota.js`
- Mode check: `shadow` returns the agent result so the caller can log it, but the *caller* decides whether to send it
- Remove the in-memory `_quota` block (now in agent-quota.js)
- `runGeminiAgent` increments `tickRequest()` on attempt, `tickFallback()` when it returns null

**Exact function signatures (contract):**

```javascript
export function isAgentEnabled() { ... }
// true iff GEMINI_API_KEY set AND BOT_AGENT_MODE in ('shadow','live')

export function agentMode() { ... }
// 'shadow' | 'live' | null  (null = disabled)

export function agentStatus() { ... }
// { enabled, mode, model, quota: { date, count, cap, fallbacks } }

export async function runGeminiAgent({ message, history }) { ... }
// Returns { reply, name?, city?, eye_power?, asks_*, power_concern?, wants_callback?, is_cataract? } | null
// null = fall back to rule-based. Caller MUST call tickFallback via this module's internal path.
```

**Critical: 429 / quota handling.** If Gemini returns HTTP 429 (rate limited) OR `isUnderQuota()` is false before the call, set a module-level `_quotaExhaustedUntil` timestamp (midnight UTC). All subsequent calls in this process return null immediately without hitting Gemini. This is the real floor — never trust the counter alone.

**System prompt:** The current `server/llm-agent.js` (the Opus version, lines 48-86) already has a well-tuned `SYSTEM_PROMPT` constant. Copy it verbatim into the new file. It encodes: the clinic context, the WhatsApp-short style, the language-mirroring rule, the "name is casual, never a gate" rule, the FACTS list (cost ₹15K-90K, recovery 3-12h, pain, eligibility, safety, referral), the hard rules (not a doctor, no invented numbers, cataract ≠ LASIK, no images), and the extraction schema.

**Response schema:** Copy `RESPONSE_SCHEMA` verbatim from the current `server/llm-agent.js` (lines 88-104). Keep JSON output mode (`responseMimeType: 'application/json'`).

**Request body:** Keep `thinkingConfig: { thinkingBudget: 0 }` (disable Gemini 2.5 thinking for speed + JSON reliability).

**Timeout:** Keep 8000ms with AbortController.

### 3.4 MODIFY: `server/index.js`

**Edit 1 — imports (after line 22, the saveWhatsAppMessage import):**

```javascript
import { isAgentEnabled, agentMode, runGeminiAgent, agentStatus } from './llm-agent.js';
import { hydrateQuota } from './agent-quota.js';
```

**Edit 2 — boot log (after line 43, NODE_VERSION log):**

```javascript
console.log('[BOOT] LLM AGENT:', isAgentEnabled() ? `${agentMode().toUpperCase()} (${process.env.GEMINI_MODEL || 'gemini-2.5-flash'})` : 'OFF (rule-based bot)');
```

**Edit 3 — hydrate quota on boot.** Inside `app.listen(...)` callback (after line 1838, the "Server running" log), add:

```javascript
hydrateQuota().catch(e => console.warn('[BOOT] quota hydrate failed:', e.message));
```

**Edit 4 — `/health` endpoint (line 56).** Add `agent: agentStatus()`:

```javascript
app.get('/health', (req, res) => {
    res.json({ status: 'ok', node: process.version, ts: new Date().toISOString(), uptime: process.uptime(), bot: 'v6.2-stable', agent: agentStatus() });
});
```

**Edit 5 — `schedulePersist()` (line 573).** Add `_agentHistory` to the persisted shape:

```javascript
// BEFORE:
toWrite[p] = { state: s.state, data: s.data, ingested: s.ingested, first_ingest_done: s.first_ingest_done || false, last_activity_at: s.last_activity_at, lang: s.lang || 'EN', repeat_count: s.repeat_count || {}, resume_offered: s.resume_offered || false, last_intent_handled: s.last_intent_handled || null };

// AFTER (add _agentHistory):
toWrite[p] = { state: s.state, data: s.data, ingested: s.ingested, first_ingest_done: s.first_ingest_done || false, last_activity_at: s.last_activity_at, lang: s.lang || 'EN', repeat_count: s.repeat_count || {}, resume_offered: s.resume_offered || false, last_intent_handled: s.last_intent_handled || null, _agentHistory: s._agentHistory || [] };
```

**Edit 6 — session hydration (line 559).** Restore `_agentHistory` when hydrating:

```javascript
// BEFORE:
botSessions[phone] = { ...s, inactivityTimer: null };

// AFTER:
botSessions[phone] = { ...s, _agentHistory: s._agentHistory || [], inactivityTimer: null };
```

**Edit 7 — replace the existing LLM gate (lines 1038-1067 in current file, the block Opus added).** The Opus block goes after `isSalesIntent` (around line 1248 in current). Replace it with this hardened version:

```javascript
// ─── LLM AGENT (Gemini, free tier) — natural conversation, with the
//     rule-based state machine below as automatic fallback.
//     Safety guards above (opt-out, abuse, off-topic, human-takeover, explicit
//     "call me") always run first and are never delegated to the LLM.
//     In shadow mode the agent runs but its reply is only logged — the
//     rule-based reply is what the customer sees. ───
if (isAgentEnabled() && session.state !== 'ASK_RESUME' && session.state !== 'RETURNING') {
    let agentResult = null;
    try {
        agentResult = await runGeminiAgent({ message, history: session._agentHistory || [] });
    } catch (e) {
        console.error('[AGENT] error → rule-based fallback:', e.message);
    }

    if (agentResult && agentResult.reply) {
        // Always reconcile session.data so the rule-based fallback (if it ever
        // fires) and the CRM pipeline see what the agent learned.
        applyAgentExtract(session, agentResult);

        // Track conversation memory (capped, persisted via schedulePersist).
        session._agentHistory = (session._agentHistory || [])
            .concat({ role: 'user', text: message }, { role: 'model', text: agentResult.reply })
            .slice(-20);
        if (session.state === 'GREETING') session.state = 'CORE_CONSULT';

        if (agentMode() === 'live') {
            setReply(agentResult.reply);
            console.log(`[AGENT:${agentMode()}] ✅ ${phone}`);
            return finalizeWithIngest(phone, session, 'agent', finalize, isTestChat);
        } else {
            // SHADOW: log what the agent would have said, fall through to
            // rule-based so the customer still gets a safe reply.
            console.log(`[AGENT:shadow] phone=${phone} inbound="${message.slice(0, 80)}" agent_reply="${agentResult.reply.slice(0, 120)}"`);
        }
    } else {
        console.log(`[AGENT:fallback] ${phone} → rule-based`);
    }
}

const knowledge = buildKnowledgeResponse(message, session);
// ... (rest unchanged)
```

**Edit 8 — fallback observability.** Inside `finalizeWithIngest` (line 1311), record a `lead_events` row when the trigger is anything other than 'agent' AND the agent is enabled. This lets the dashboard show "this lead's last 3 replies came from the rule-based fallback." Cheap, fire-and-forget:

```javascript
function finalizeWithIngest(phone, session, trigger, finalizeFn, isTestChat = false) {
    setImmediate(async () => {
        try {
            await sendToAPI(phone, session, trigger);
            // If the agent is enabled but this reply came from rule-based, emit a
            // lead_events row so we can measure fallback rate in the dashboard.
            if (isAgentEnabled() && trigger !== 'agent') {
                supabaseAdmin.from('lead_events').insert({
                    phone, ts: new Date().toISOString(),
                    event_type: 'agent_fallback',
                    source: 'agent',
                    payload: { trigger, message: (session.data?.lastMessage || '').slice(0, 200) },
                }).then(() => {}, () => {});
            }
        } catch (e) { console.error('[ASYNC_INGEST_ERROR]', e); }
    });
    return finalizeFn(isTestChat);
}
```

### 3.5 KEEP: `applyAgentExtract()` helper (Opus added this around line 1038 — it's correct)

No changes. It maps agent extraction onto `session.data` using the existing `isValidName` and `parseEyePower` helpers, and sets `callback_source: 'agent'` when the agent detected callback intent. This is what makes the handoff clean.

---

## 4. Rollout plan

### Phase 0 — Pre-flight (no key needed)
- [ ] Apply migration `create_agent_quota.sql` in Supabase (manual, one-time)
- [ ] Commit all code to a feature branch `feat/llm-agent-v2` (NOT main)
- [ ] Run unit tests (section 5.1) — all must pass
- [ ] Node syntax check both files

### Phase 1 — Local integration test (real key, no WhatsApp)
- [ ] Get free key at aistudio.google.com
- [ ] `.env` locally: `GEMINI_API_KEY=...`, `BOT_AGENT_MODE=shadow`
- [ ] Start server: `npm run server`
- [ ] Hit `/health` → confirm `agent.enabled: true, mode: 'shadow'`
- [ ] Run the 6 scripted conversations in section 5.2 via `/chat`
- [ ] All shadow logs must look sensible before proceeding

### Phase 2 — Shadow mode in production (3-5 days)
- [ ] Merge `feat/llm-agent-v2` to main
- [ ] Railway env vars: `GEMINI_API_KEY`, `BOT_AGENT_MODE=shadow`
- [ ] Deploy. Confirm `/health` shows `mode: shadow`.
- [ ] **Customers still get rule-based replies.** Agent replies are in logs only.
- [ ] Daily: grep Railway logs for `[AGENT:shadow]`, read 20-30 agent replies, tune system prompt if needed.
- [ ] Watch `/health` `agent.quota.count` — confirm we stay under cap.
- [ ] Watch `[AGENT:fallback]` rate — if >10%, investigate why.

### Phase 3 — Go live
- [ ] Only after shadow replies look consistently good for 3+ days
- [ ] Railway env: `BOT_AGENT_MODE=live`
- [ ] Deploy. Confirm `/health` shows `mode: live`.
- [ ] Monitor first 20-30 live conversations closely.
- [ ] Instant rollback: set `BOT_AGENT_MODE=shadow` (or delete `GEMINI_API_KEY`) → rule-based only. ~90s.

---

## 5. Test plan

### 5.1 Unit tests (no API key) — `server/llm-agent.test.js`

Mock `globalThis.fetch` to simulate Gemini responses. Assert:

1. **Happy path:** mock returns valid JSON → `runGeminiAgent` returns parsed object
2. **HTTP 429:** mock returns 429 → returns null + sets `_quotaExhaustedUntil` → next call returns null without calling fetch
3. **HTTP 500:** mock returns 500 → returns null
4. **Timeout:** mock never resolves, AbortController fires at 8s → returns null
5. **Malformed JSON:** mock returns "not json" → returns null
6. **Blocked:** mock returns `promptFeedback.blockReason` → returns null
7. **Empty reply:** mock returns `{ candidates: [{ content: { parts: [{ text: "" }] } }] }` → returns null
8. **`isAgentEnabled()`:** no env → false; key only → false; key + `BOT_AGENT_MODE=shadow` → true; key + `BOT_AGENT_MODE=invalid` → false
9. **`applyAgentExtract`:** name with invalid name → ignored; name "Rahul" → sets `contactName`; eye_power "-2.5" → sets `eyePower` + `concern_power`; eye_power "high power" → sets only `concern_power`; `wants_callback` → sets `request_call + callback_offered + human_handoff_started + callback_source='agent'`

### 5.2 Integration tests (real key, `/chat` endpoint) — manual script

Run each via `curl -X POST localhost:3000/chat -H 'Content-Type: application/json' -d '{...}'`.

**Conversation A — happy path:**
1. `{ "phone": "test1", "message": "hi" }` → expect greeting
2. `{ "phone": "test1", "message": "rahul" }` → expect name ack + question
3. `{ "phone": "test1", "message": "delhi se hoon" }` → expect city captured
4. `{ "phone": "test1", "message": "meri power -2.5 hai" }` → expect power captured
5. `{ "phone": "test1", "message": "kitne ka padega?" }` → expect cost KB
6. `{ "phone": "test1", "message": "call me" }` → expect callback message (rule-based, escalation guard)

**Conversation B — Hinglish:**
1. `{ "phone": "test2", "message": "surgery kab kar sakte hain" }` → high-intent greeting
2. `{ "phone": "test2", "message": "mera naam amit hai" }` → name ack
3. `{ "phone": "test2", "message": "recovery kitne din ki hai" }` → recovery KB in Hinglish

**Conversation C — cataract trap:**
1. `{ "phone": "test3", "message": "main 66 ka hoon, door ka nahi dikhta" }` → MUST NOT pitch LASIK. Must acknowledge cataract is different, offer specialist. Check `is_cataract: true` in logs.

**Conversation D — mid-conversation quota exhaustion:**
- Manually set `GEMINI_DAILY_CAP=2`, send 3 messages → 3rd must fall back to rule-based, log `[AGENT:fallback]`, emit `agent_fallback` lead_event.

**Conversation E — abuse mid-conversation:**
- Send 2 normal messages, then "chutiye ho kya" → MUST be handled by rule-based abuse guard, NOT the agent. Bot must pause + push escalation.

**Conversation F — restart mid-conversation:**
- Send 3 messages, kill server, restart, send message #4 → agent must resume with context (no re-greeting), because `_agentHistory` was persisted to `sessions.json`.

### 5.3 Acceptance criteria for going live

- All 9 unit tests pass
- All 6 integration conversations behave as specified
- Shadow mode runs in production for ≥3 days with <10% fallback rate
- Zero customer complaints attributable to agent replies
- `/health` quota stays under cap every day

---

## 6. What this does NOT change

- **CRM pipeline** (crm-automation.js, refrens-sync.js): untouched, frozen
- **Auto-push worker**: untouched — reads same `leads_surgery` fields
- **Dashboard** (`relive-cure-dashboard`): untouched — no new UI in this spec
- **Supabase schema for leads**: untouched — agent writes via existing `ingestLead`
- **WhatsApp send / capture**: untouched
- **Refrens sync scheduler, Meta Ads sync, push notifications, call recordings**: untouched

---

## 7. Privacy note (founder decision, not a code decision)

Free-tier Gemini processes chats to improve Google's products. For a clinic handling lead PII (name, phone, eye power, insurance status), this is a real trade-off. Options if it becomes a concern:

- **Stay free:** Accept the trade-off at current volume (~100 leads/day).
- **Switch to paid Gemini:** Same code, just a paid key. Removes the training-data clause.
- **Switch to Claude Haiku:** One-file change in `llm-agent.js` (swap the URL + request shape). Anthropic's commercial terms don't use customer data for training.

This spec implements Gemini free-tier as the default per founder's "without any cost" requirement. The provider swap is intentionally isolated to one module.

---

## 8. Rollback

At any point, any of these instantly reverts to pure rule-based:

1. Set `BOT_AGENT_MODE=shadow` (if live) → agent still runs for logs, customers get rule-based
2. Delete `GEMINI_API_KEY` → `isAgentEnabled()` returns false, agent block skipped entirely
3. Revert the merge on GitHub → code-level rollback

Railway redeploy takes ~90 seconds. No data loss, no migration to undo. The `agent_quota` and `agent_fallback` rows are harmless historical data.
