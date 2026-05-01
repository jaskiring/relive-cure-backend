# PERFORMANCE_PLAN.md
# Relive Cure — Performance Design

Generated: 2026-05-01  
Targets: Sub-2s reply latency end-to-end. Non-blocking webhook. Parallel CRM processing.

---

## TARGET METRICS

| Metric | Target | Current state |
|--------|--------|--------------|
| Reply latency (message received → WhatsApp delivered) | < 2s | 2–45s (sendToAPI blocks) |
| Webhook handler return time (Meta must get 200) | < 500ms | < 100ms (immediate sendStatus 200) ✓ |
| Session read time | < 100ms | < 50ms (in-memory) but lost on restart |
| State machine execution | < 5ms | < 5ms ✓ (pure sync) |
| CRM push per lead | < 30s | ~10s (too tight, often fails) |
| CRM batch (20 leads, concurrency 3) | < 3min | ~3.5min (timeout cascades) |
| Backend cold start response | < 5s | 5–10s (keep-alive mitigates) |
| Dashboard initial load | < 1s | ~2s (SELECT * all rows) |

---

## SECTION 1 — REPLY LATENCY BREAKDOWN

### Current critical path (where time is spent):

```
Meta delivers message
    │
    ▼ ~0ms
Express handler (res.sendStatus(200)) ← correct, immediate
    │
    ▼ ~10–50ms
Load in-memory session ← fast, but volatile
    │
    ▼ ~50–200ms
checkExistingLead() for new users ← GET /api/check-lead (network call, blocking)
    │
    ▼ ~5ms
State machine execution (pure sync) ← fast ✓
    │
    ▼ ~0–40,000ms    ← THE PROBLEM
sendToAPI() — awaited BEFORE reply sent
    │
    ▼ ~500ms
sendWhatsAppReply() — Meta Graph API call

Total worst case: 40s+ (backend cold start + 5 retries × 40s timeout)
Total typical case: 2–4s
```

### Target critical path:

```
Meta delivers message
    │
    ▼ ~0ms
Express handler (res.sendStatus(200)) ← immediate ✓
    │
    ▼ ~20ms
Dedup check + lock acquire ← O(1) Set lookup
    │
    ▼ ~50–100ms
Session read from Supabase ← indexed by phone_number PK, fast
    │
    ▼ ~5ms
State machine (pure sync, no I/O) ← fast ✓
    │
    ▼ ~0ms
Session write (non-blocking, fire-and-forget relative to reply)
    │
    ▼
Promise.all([sendWhatsAppReply, ingestToBackend])
    │
    sendWhatsAppReply ← ~300–800ms (Meta Graph API, well under 2s)
    ingestToBackend ← parallel, does not affect reply timing

Total typical case: 50ms (session read) + 5ms (state machine) + 500ms (Meta API) = ~600ms
Total worst case (session store slow): 100ms + 5ms + 800ms = ~900ms
```

**Key change that achieves this**: `sendToAPI` removed from the critical reply path entirely.

---

## SECTION 2 — NON-BLOCKING WEBHOOK DESIGN

### Rule: Nothing in the webhook handler may block reply generation.

The only operations allowed BEFORE reply is determined (Steps 0–4):
1. Parse request body — sync, O(1)
2. Dedup check — sync, O(1)
3. Lock acquire — sync, O(1)
4. Session read — ONE async call, 100ms timeout (fail-fast, not 40s)
5. State machine — pure sync

The only operation allowed at 100ms timeout (not 3s) for session read:
- Session read must have an aggressive timeout: 100ms, not 3s
- On timeout → treat as new session, log warning
- This ensures even cold Supabase connections don't stall replies

Operations that are ALWAYS async and parallel (after reply is determined):
- sendWhatsAppReply
- ingestToBackend
- Session write

### Timeout Hierarchy

```
Meta webhook → chatbot must respond (200) within: 5s (Meta requirement)
Session read timeout: 100ms (aggressive — new session on timeout)
State machine: < 5ms (sync, no I/O)
Session write timeout: 2s (non-blocking, failure is logged not fatal)
sendWhatsAppReply attempt timeout: 2s per attempt
ingestToBackend attempt timeout: 8s per attempt (not in reply path)
```

---

## SECTION 3 — PARALLEL CRM PROCESSING

### Current p-queue configuration (correct, keep):

```
concurrency: 3        — 3 leads processed simultaneously
intervalCap: 6        — max 6 tasks per 10 seconds
interval: 10000ms
```

### Performance problem: sequential cookie auth check

**Current**: Every lead individually navigates to `refrens.com/app` to exchange cookies.  
This means each of the 3 concurrent leads makes a separate auth round-trip.

**Improved design: Single pre-push auth check, shared token**

```
Before processQueue():
  1. One browser context opens refrens.com/app
  2. Captures __at token (5s timeout)
  3. If token captured: pass capturedToken to all processLead() calls
  4. processLead() skips the auth navigation — uses passed token directly
  5. One auth round-trip instead of N auth round-trips

This saves: (N-1) × ~3s per batch
For 20 leads: saves ~57s (19 × 3s avoided)
```

### CRM push timing targets per lead:

```
Token injection: ~0ms (already have token, use evaluateOnNewDocument)
Navigate to form: ~2–4s (Refrens page load)
Org selector: ~500ms
Stage dropdown: ~500ms
Fill 7 fields: ~1–2s (10ms delay per char × avg 30 chars per field × 7 fields = ~2.1s)
Assert + submit: ~1s
Navigation wait: ~2–4s (Refrens redirect)
Context cleanup: ~100ms

Total per lead: ~8–12s (with 30s timeout = comfortable margin)
```

### Batch performance (20 leads, concurrency 3):

```
Without shared token (current): 20 × 10s avg = 200s total time / 3 = ~67s wall time
With shared token: first auth 5s + (20 × 8s / 3) = 5s + 53s = ~58s wall time
With browser health check overhead: +2s buffer = ~60s for 20 leads

Current 10s timeout: too tight (8–12s actual time = frequent timeouts)
30s timeout: comfortable margin, allows for Refrens slow pages
```

---

## SECTION 4 — SESSION STORE PERFORMANCE

### Supabase `bot_sessions` table design for performance:

```
Table: bot_sessions
Columns:
  phone_number  TEXT PRIMARY KEY    — O(1) lookup by phone
  state         TEXT NOT NULL
  data          JSONB NOT NULL      — all session.data fields
  trace_id      UUID NOT NULL
  last_activity_at  TIMESTAMPTZ NOT NULL
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()

Indexes:
  PRIMARY KEY on phone_number — B-tree, all reads use this
  
  Optional (for TTL cleanup job):
  INDEX on last_activity_at WHERE last_activity_at < now() - interval '7 days'

No other indexes needed — all reads are single-row by phone_number.
```

### Expected query times:

```
READ by phone (PK lookup): < 5ms (Supabase, indexed)
UPSERT by phone (PK): < 10ms
These are far within the 100ms session read budget.
```

### TTL cleanup (no code needed):

```
Supabase pg_cron job (or Railway cron):
  DELETE FROM bot_sessions WHERE last_activity_at < now() - interval '7 days'
  Run: once per day at off-peak hours
  Prevents unbounded table growth.
```

---

## SECTION 5 — DASHBOARD PERFORMANCE

### Current problem:

```
supabase.from('leads_surgery').select('*')
  → fetches ALL columns for ALL rows
  → no pagination
  → slow as table grows (100+ rows: noticeable, 1000+ rows: degraded)
```

### Improved query design:

```
List view query (table with pagination):
  SELECT id, phone_number, contact_name, city, status, intent_level,
         parameters_completed, pushed_to_crm, request_call,
         interest_cost, interest_recovery, concern_pain, concern_safety,
         assignee, created_at, last_activity_at, is_returning
  FROM leads_surgery
  ORDER BY created_at DESC
  LIMIT 200 OFFSET {page * 200}

Excluded from list view (fetched only in detail panel):
  last_user_message, user_questions, bot_fallback, remarks,
  crm_push_last_error, crm_push_attempts, preferred_surgery_city, timeline
  (These are heavy/infrequently needed — load on demand)

Detail panel query (when admin opens a lead):
  SELECT * FROM leads_surgery WHERE id = '{lead_id}'
  (full row, single fetch, on demand)
```

### Realtime subscription (keep as-is):

```
Supabase realtime subscription on leads_surgery is correct.
Filter to only receive relevant events:
  .on('postgres_changes', { event: '*', schema: 'public', table: 'leads_surgery' }, ...)
This is already correct. Keep it.
```

### 8-second polling (keep for now):

```
The 8s polling interval is a reasonable fallback for realtime failures.
At current scale (< 500 leads) this is acceptable.
At > 1000 leads, consider increasing to 30s or removing polling entirely
(rely only on realtime subscription + manual refresh).
```

---

## SECTION 6 — KEEP-ALIVE DESIGN (BOTH SERVICES)

### Backend (already implemented, keep):

```
setInterval(selfPing, 4 * 60 * 1000)
Pings GET /health every 4 minutes.
Gated on RAILWAY_PUBLIC_DOMAIN env var.
```

### Chatbot (add this):

```
Add identical keep-alive to chatbot's server.js:
setInterval(() => {
  fetch('https://{RAILWAY_PUBLIC_DOMAIN}/health').catch(e => console.warn('[KEEPALIVE]', e.message))
}, 4 * 60 * 1000)
Gated on RAILWAY_PUBLIC_DOMAIN.

This prevents Railway from sleeping the chatbot.
```

### Why 4 minutes (not less):

```
Railway's sleep threshold is ~5 minutes of inactivity.
4 minutes keeps the container awake with 1 minute margin.
Supabase cache TTL is also ~5 minutes — 4 minute ping keeps connections warm.
```

---

## SECTION 7 — CRITICAL PATH SUMMARY

```
MUST be on critical path (blocking reply):
  ✓ Session read (100ms aggressive timeout)
  ✓ State machine execution (sync, < 5ms)
  ✓ Dedup check (sync, O(1))
  ✓ Per-phone lock (sync, O(1))

MUST be off critical path (parallel after reply determined):
  ✓ sendWhatsAppReply (async, parallel)
  ✓ ingestToBackend (async, parallel)
  ✓ Session write (async, parallel)
  ✓ Health ping (remove from sendToAPI entirely)

REMOVE from codebase entirely:
  ✗ health ping inside sendToAPI
  ✗ await sendToAPI before await sendWhatsAppReply
  ✗ 5 retries × 40s timeout (replace with 3 retries × 8s)
  ✗ "initial" sendToAPI call on new user first message (empty payload)
```
