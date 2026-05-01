# EXECUTION_FLOW.md
# Relive Cure — Exact Message Execution Flow

Generated: 2026-05-01  
Constraint: 1 input → exactly 1 reply. Deterministic. No loops.

---

## OVERVIEW

This document defines the exact, step-by-step execution of a single WhatsApp message from arrival to completion. Every branch is explicit. Every outcome is defined.

---

## FULL EXECUTION DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│  META WEBHOOK (or direct {phone, message} from test)            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 0: RECEIVE + ACK                                          │
│                                                                 │
│  • Express handler fires                                        │
│  • res.sendStatus(200) — immediately, before anything else      │
│  • Extract: phone, message_text, message_id (if Meta format)    │
│  • Derive: message_lower = message_text.trim().toLowerCase()    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: DEDUPLICATION                                          │
│                                                                 │
│  message_id present?                                            │
│    YES → already in dedup_set?                                  │
│             YES → STOP. No processing. No reply.               │
│             NO  → add to dedup_set (evict oldest if size > 1000)│
│    NO  → skip dedup check (simple format, no message_id)        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: PER-PHONE PROCESSING LOCK                              │
│                                                                 │
│  phone already locked?                                          │
│    YES → enqueue this message for phone. Return.               │
│           (will be processed after current message completes)   │
│    NO  → acquire lock for phone                                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: LOAD SESSION                                           │
│                                                                 │
│  Read session from persistent store by phone (3s timeout)       │
│                                                                 │
│  Session found?                                                 │
│    YES → use existing: { state, data, trace_id, ... }          │
│    NO  → create: {                                              │
│            state: 'GREETING',                                   │
│            data: {},                                            │
│            trace_id: generateUUID(),                            │
│            created_at: now                                      │
│          }                                                      │
│                                                                 │
│  Store failure (timeout/error)?                                 │
│    → treat as NOT FOUND (create fresh session)                  │
│    → log: { level:'error', event:'session_read_failed', phone } │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: DETERMINE REPLY (pure sync — no I/O, no await)         │
│                                                                 │
│  Input:  session.state, session.data, message_text, msg_lower   │
│  Output: { reply, newState, dataUpdates, ingestionTrigger }     │
│                                                                 │
│  [See LAYER EXECUTION below]                                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5: COMMIT SESSION STATE                                   │
│                                                                 │
│  merged_data = { ...session.data, ...dataUpdates }              │
│  Write: { state: newState, data: merged_data,                   │
│           last_activity_at: now } to persistent store            │
│                                                                 │
│  Write success? → continue                                      │
│  Write failure? → log error with trace_id, continue anyway      │
│                   (reply will still be sent)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 6: FIRE ASYNC OPERATIONS IN PARALLEL                      │
│                                                                 │
│  Promise.all([                                                  │
│    sendWhatsAppReply(phone, reply),      ← Operation A          │
│    ingestToBackend(phone, merged_data,   ← Operation B          │
│                    ingestionTrigger)      (only if trigger≠null) │
│  ])                                                             │
│                                                                 │
│  Both are fire-and-forget relative to each other.              │
│  Neither can generate additional replies.                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 7: RELEASE LOCK                                           │
│                                                                 │
│  Release per-phone lock.                                        │
│  If messages queued for this phone → process next message.      │
└─────────────────────────────────────────────────────────────────┘
```

---

## LAYER EXECUTION (STEP 4 DETAIL)

```
STEP 4 input: { state, data, message_text, message_lower }

══════════════════════════════════════════════
LAYER 1: GLOBAL OVERRIDES
══════════════════════════════════════════════

CHECK 1.1 — RESTART DETECTION
  Condition: message_lower is EXACTLY one of:
    ['hi', 'hello', 'hey', 'start', 'hii', 'helo']
  Action:
    has_data = data.contactName && data.contactName !== 'WhatsApp Lead'
    if has_data:
      newState = 'ASK_RESUME'
      reply = "Welcome back, {firstName}! 👋\n\nWould you like to continue where we left off?\nStill needed: {missing_fields}\n\nReply *Yes* to continue or *No* to just chat 😊"
    else:
      newState = 'GREETING'
      reply = "Hi 👋 I'm the LASIK consultation assistant.\n\nWe help patients connect with trusted eye hospitals.\n\nShall I help you with a few quick details to guide you?"
  dataUpdates = {} (no data changes on restart)
  ingestionTrigger = null
  → RETURN immediately (skip Layers 2 and 3)

CHECK 1.2 — SALES INTENT
  Condition: message_lower matches ANY of these SPECIFIC phrases:
    ["call me", "call back", "talk to doctor", "talk to specialist",
     "book appointment", "book consultation", "speak to advisor",
     "human help", "baat karni hai", "doctor se baat", "call karein",
     "call karo", "appointment chahiye", "consultation chahiye"]
  Note: single words like "help", "number", "phone", "contact"
        are EXCLUDED from this check.
  Action:
    newState = UNCHANGED (keep current state)
    dataUpdates = { request_call: true }
    reply = "👍 Got it!\n\nOur LASIK specialist will call you shortly.\n\nMeanwhile, you can ask me about:\n• Cost\n• Recovery\n• Eligibility"
    ingestionTrigger = 'sales_intent'
  → RETURN immediately (skip Layers 2 and 3)

CHECK 1.3 — EYE POWER DETECTION
  Condition: message matches the strict pattern:
    regex = /(?:power|number|no\.?)?\s*[-+]\d{1,2}(\.\d{1,2})?\b/i
    Examples that MATCH: "-3.5", "+2.0", "power -4", "no. -2.5"
    Examples that DON'T match: "3-4 months", "25 years", "₹45,000"
  Action:
    newState = UNCHANGED
    dataUpdates = { concern_power: true }
    firstName = data.contactName ? data.contactName.split(' ')[0] : ''
    reply = "{greeting}Based on your eye power, you could be a good candidate for LASIK.\n\nWould you like me to check your eligibility quickly?"
    ingestionTrigger = 'power_detected'
  → RETURN immediately (skip Layers 2 and 3)

══════════════════════════════════════════════
LAYER 2: KNOWLEDGE LAYER
(only reached if no global override matched)
══════════════════════════════════════════════

CHECK 2.0 — STATE ELIGIBILITY GATE
  Knowledge is ONLY allowed in these states:
    GREETING, ASK_PERMISSION, ASK_RESUME, NAME, CITY, COMPLETE
  If current state is NAME, SURGERY_CITY, INSURANCE, TIMELINE, RETURNING:
    → skip Layer 2 entirely, proceed to Layer 3

CHECK 2.1 — DETECT KNOWLEDGE INTENTS
  Scan message_lower against intent keyword lists (RECOVERY, PAIN,
  ELIGIBILITY, REFERRAL, COST, TIMELINE, SAFETY)
  YES intents detected (excluding YES intent):
    → build combined knowledge response (max 2 intents combined)
    → set intelligence flags ONLY:
        if COST intent → dataUpdates.interest_cost = true
        if RECOVERY intent → dataUpdates.interest_recovery = true
        if PAIN intent → dataUpdates.concern_pain = true
        if SAFETY intent → dataUpdates.concern_safety = true
    STRICT RULE: do NOT set data.timeline, data.city, or any
                 qualification field in this layer
    → append CTA: "\n\nWould you like me to arrange a quick consultation call?"
    → append flow resume question (next unanswered qualification field)
    newState = UNCHANGED
    ingestionTrigger = 'knowledge'
    → RETURN (skip Layer 3)
  NO intents detected:
    → proceed to Layer 3

══════════════════════════════════════════════
LAYER 3: STATE MACHINE
(only reached if no override and no knowledge matched)
══════════════════════════════════════════════

  Execute the handler for the current session.state.
  See STATE_MACHINE_V2.md for all state handlers.

══════════════════════════════════════════════
FALLBACK (if Layer 3 has no matching handler)
══════════════════════════════════════════════

  reply = "I didn't fully get that, but I can help with:\n\n• LASIK cost\n• Recovery time\n• Eligibility\n\nOr I can arrange a specialist call for you."
  newState = UNCHANGED
  dataUpdates = {}
  ingestionTrigger = null
```

---

## OPERATION A — SEND WHATSAPP REPLY (DETAIL)

```
sendWhatsAppReply(phone, reply_text):

  1. Check: WHATSAPP_ACCESS_TOKEN + PHONE_NUMBER_ID present?
     NO  → log dry-run: { phone, reply_preview: reply_text.slice(0,50) }
           return (no network call)
     YES → proceed

  2. POST to Meta Graph API:
     URL: https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages
     Body: { messaging_product: "whatsapp", to: phone, type: "text",
             text: { body: reply_text } }
     Headers: Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
     Timeout: 5s per attempt

  3. Response handling:
     200 → log success, return
     429 → read Retry-After header (default 5s if absent), wait, retry once
     5xx → retry with backoff (see below)
     4xx (not 429) → log error, do NOT retry (bad payload or invalid phone)

  4. Retry schedule (on failure):
     Attempt 1: immediately
     Attempt 2: wait 500ms
     Attempt 3: wait 1000ms
     After attempt 3 failure: log { level:'error', event:'reply_failed',
       trace_id, phone_last4: phone.slice(-4), error }
     DO NOT send a second reply. DO NOT throw.
```

---

## OPERATION B — INGEST TO BACKEND (DETAIL)

```
ingestToBackend(phone, merged_data, trigger):

  1. If trigger is null → skip entirely

  2. Build payload:
     { phone_number, contact_name, city, preferred_surgery_city,
       timeline, insurance, interest_cost, interest_recovery,
       concern_pain, concern_safety, concern_power, intent_level,
       intent_score, urgency_level, request_call, last_user_message,
       ingestion_trigger: trigger }

  3. POST to https://relive-cure-backend-production.up.railway.app/api/ingest-lead
     Headers: x-bot-key: {BOT_SECRET}, x-trace-id: {trace_id}
     Timeout: 8s per attempt

  4. Retry schedule (on failure):
     Attempt 1: immediately
     Attempt 2: wait 2s
     Attempt 3: wait 4s
     After attempt 3 failure: write to Supabase pending_ingestion table:
       { phone, payload_json, trigger, trace_id, failed_at, retry_count: 3 }
     DO NOT throw. DO NOT send a reply.

  5. On success: log { level:'info', event:'ingestion_success', trace_id, lead_id }
```

---

## INACTIVITY TIMER EXECUTION

```
Timer setup:
  - Set when session transitions to non-terminal state
  - Duration: 2 minutes
  - Reset on every new message (clear existing, create new)
  - NOT set for COMPLETE or RETURNING states

Timer fires:
  → ONLY calls ingestToBackend(phone, session.data, 'timeout')
  → NEVER calls sendWhatsAppReply
  → NEVER advances session state
  → After ingest: mark session.inactivity_fired = true (prevents double-fire)
```

---

## RETURNING USER PATH

```
User messages for the first time in this process instance.
No session found in persistent store.

1. Create GREETING session (Step 3)
2. In Layer 3 — GREETING state handler:
   a. Call GET /api/check-lead/:phone (backend API, 3s timeout)
   b. lead found? → set state = RETURNING, data.contactName = lead.contact_name,
                    data.is_returning = true
      no lead? → keep state = GREETING
3. Both paths return exactly one reply.
   RETURNING → "Welcome back, {firstName}! 👋 What would you like to know?"
   GREETING  → "Hi 👋 I'm the LASIK consultation assistant. ..."

Note: The /api/check-lead call is INSIDE the state handler, which is inside
Step 4 (sync step). This is the ONE exception to "no I/O in Step 4" —
it is acceptable here because it runs once per new session, its result
determines state, and its timeout is 3s (well within Meta's 5s window).
```

---

## EDGE CASES

| Scenario | Handling |
|----------|---------|
| Empty message | Fallback reply. No state change. No ingest. |
| Message with only whitespace | Trim → empty → fallback |
| Very long message (>1000 chars) | Truncate last_user_message to 1000 chars before ingest |
| Phone number in non-E.164 format | Store as-is. Backend handles. No normalization in chatbot. |
| User sends same message twice within 5s | Dedup on message_id (Meta format) or per-phone lock (simple format) |
| ASK_RESUME with no missing fields | State → COMPLETE. Reply: "All details saved ✅" |
| INSURANCE state receives knowledge query | Layer 2 eligibility gate blocks it (INSURANCE not in allowed states). Layer 3 runs. Input is captured as insurance answer. |
| User says "no" to ASK_PERMISSION (resume) | State → COMPLETE. Reply: knowledge-only fallback. |
