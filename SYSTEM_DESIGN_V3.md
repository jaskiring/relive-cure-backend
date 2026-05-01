# SYSTEM_DESIGN_V3.md
# Relive Cure — System Design Validation + Ideal Architecture

Generated: 2026-05-01  
Source: Code inspection of all three repos. No external docs referenced.  
Mode: Design only. No code. No execution.

---

## SECTION 1 — ARCHITECTURAL FLAW INVENTORY

Each flaw is grounded in observed code, not assumptions.

---

### Flaw 1 — Duplicate /webhook endpoints with shared verify_token

**File**: `server/index.js` (backend) and `server.js` (chatbot)  
**Observation**: Both services expose `GET /webhook` and `POST /webhook` with the same hardcoded `hub.verify_token = 'relive_verify_token_123'`. Meta's webhook registration only points to one URL, but both services will pass the verification handshake. There is no code guard to prevent accidental re-registration to the wrong service.

**Effect**: Silent degradation if Meta is reconfigured. Backend's `/webhook` calls the chatbot and waits for a JSON body response that never comes (chatbot sends `res.sendStatus(200)` with no body), resulting in fallback reply `'Got it 👍'` for every user.

**Verdict**: Backend `/webhook` must be removed or disabled.

---

### Flaw 2 — `sendToAPI` is blocking the critical reply path in some transitions

**File**: `server.js` (chatbot), line ~661 (NAME state)  
**Observation**: In the NAME, CITY, SURGERY_CITY, and INSURANCE states, the code does:
```
await sendToAPI(phone, session, "update");
await sendWhatsAppReply(phone, nextQuestion);
```
`sendToAPI` has a 40-second axios timeout. If the backend is slow or cold-starting, the WhatsApp reply is delayed up to 40 seconds (× 5 retry attempts = up to 3.3 minutes in worst case). The user receives no reply during this time. Meta also does not retry while awaiting the original message response.

**Verdict**: `sendToAPI` must NEVER block reply sending. Both must run in parallel after reply is determined.

---

### Flaw 3 — Health ping fired on every `sendToAPI` call

**File**: `server.js` (chatbot), line ~159  
**Observation**: Inside `sendToAPI`, before the retry loop:
```javascript
axios.get("https://relive-cure-backend-production.up.railway.app/health").catch(...)
```
This fires an HTTP GET to the backend on every single `sendToAPI` call. A full conversation generates 5–8 `sendToAPI` calls, each triggering a health ping. This adds unnecessary outbound network calls and is redundant with the backend's own keep-alive mechanism.

**Verdict**: Remove health ping from `sendToAPI`. Keep-alive is the backend's responsibility.

---

### Flaw 4 — No message-level deduplication in the chatbot

**File**: `server.js` (chatbot)  
**Observation**: The backend's `POST /webhook` has a `processedMessageIds` Set for dedup. The chatbot's `POST /webhook` has no equivalent. Meta retries unacknowledged webhooks and can deliver the same message 2–3 times. The chatbot sends `res.sendStatus(200)` immediately, so Meta considers delivery confirmed, but if a message is duplicated at the network layer before reaching Express, it will be processed twice.

More critically: `handleIncomingMessage` is called after `res.sendStatus(200)`. If two identical requests arrive within milliseconds (load balancer retries, Meta duplicates), both will process the same `sessions[phone]` object simultaneously in Node's event loop. Because `handleIncomingMessage` is async and yields control at `await` points, two executions can interleave, both seeing the same state and both advancing it.

**Verdict**: Add `messageId` deduplication at the top of the chatbot's webhook handler.

---

### Flaw 5 — State can advance without reply being sent

**File**: `server.js` (chatbot), NAME state  
**Observation**: Pattern in multiple state handlers:
```javascript
session.data.contactName = message;      // 1. data written
session.state = "CITY";                  // 2. state advanced
await sendToAPI(phone, session, "update");  // 3. API call (can fail/hang)
await sendWhatsAppReply(phone, "...");   // 4. reply sent
```
If `sendWhatsAppReply` fails (Meta API error), the state has already advanced to `CITY` and data is already saved. The user received no reply but the bot thinks it asked the city question. On the user's next message, the bot expects a city name but the user doesn't know they were asked.

**Verdict**: Reply must be sent before state is committed. Or: state is committed only after reply is sent. In practice: determine reply first, commit state + send reply atomically (or accept that state commit failure is recoverable but reply failure is not).

---

### Flaw 6 — TIMELINE intent in INTENTS overlaps with TIMELINE state

**File**: `server.js` (chatbot), lines ~265–270 and ~558–568  
**Observation**: When `session.state === "TIMELINE"`, the `TIMELINE STATE OVERRIDE` block runs first (correct), captures `message` as timeline, and advances to COMPLETE. But the `buildKnowledgeResponse` check runs AFTER the TIMELINE STATE OVERRIDE in the code. The TIMELINE STATE OVERRIDE returns early, so knowledge does not fire. This is correct behavior.

However, `buildKnowledgeResponse` also sets `session.data.timeline = message` when TIMELINE intent is detected (line ~418). If state is NOT TIMELINE but user says "next week" (a TIMELINE intent keyword) in an allowed knowledge state, this sets `session.data.timeline` without advancing state. The next `sendToAPI` call will include this incorrectly captured timeline value.

**Verdict**: Knowledge layer must not mutate `session.data.timeline`. It may set intelligence flags (interest_cost, etc.) but must not modify qualification fields.

---

### Flaw 7 — SALES_INTENT includes overly broad terms

**File**: `server.js` (chatbot), line ~278–281  
**Observation**: SALES_INTENT array includes: `"help"`, `"number"`, `"phone"`, `"contact"`, `"interested"`. These are extremely common words. A user asking "what is the contact number for the hospital?" matches three SALES_INTENT terms: `contact`, `number`, `phone`. This triggers `request_call = true` and sends "our specialist will call you" — even though the user asked a factual question.

**Verdict**: SALES_INTENT must use more specific multi-word phrases, not single common words.

---

### Flaw 8 — POWER detection regex is too broad

**File**: `server.js` (chatbot), line ~546  
**Observation**: `const powerMatch = message.match(/[-+]\d+(\.\d+)?|\b\d+\.\d+\b/)` — matches any decimal or negative number. Examples that incorrectly trigger power detection: "I'm 25 years old", "₹45,000", "1.5 km", "3-4 months", "25,000 rupees" (comma prevents match here but `-` in "3-4" would trigger `-4`). Every time this fires, `concern_power = true` is set and the user gets an eligibility response instead of their actual question answered.

**Verdict**: Power regex must be more specific: require context like `-5.0` or `+3.5` (optionally preceded by "power", "number", minus, or plus), not just any decimal.

---

### Flaw 9 — `sendToAPI` called with "initial" trigger on new user first message before any data collected

**File**: `server.js` (chatbot), line ~507–509  
**Observation**: For a new user whose session is just created:
```javascript
sessions[phone].data.lastMessage = msgLow;
await sendToAPI(phone, sessions[phone], "initial");
```
At this point, `data` contains only `lastMessage`. Name, city, all fields are empty. The payload sent has `contact_name: "WhatsApp Lead"`, zero qualification fields, `intent_level: "COLD"`. This creates a nearly empty DB row. The `sendToAPI` call also awaits (blocking this first message's processing for up to 40s timeout × 5 retries in the worst case).

**Verdict**: The "initial" trigger call should be deferred — either skip it entirely (the first real data upsert comes after name is collected) or fire it truly async without awaiting.

---

### Flaw 10 — Race condition on rapid sequential messages

**File**: `server.js` (chatbot)  
**Observation**: `handleIncomingMessage` is `async`. If two messages arrive from the same phone within milliseconds (possible with Meta webhook retries), both calls enter `handleIncomingMessage` concurrently. Node.js is single-threaded but yields at every `await`. Both executions can read the same session state (e.g., `CITY`), both expect the city answer, both call `sendToAPI` with the same data, and both advance state to `SURGERY_CITY`. Result: user receives two replies to one message and state is double-advanced.

**Verdict**: Add a per-phone processing lock. While a message from phone X is being processed, queue subsequent messages from phone X rather than processing in parallel.

---

## SECTION 2 — IDEAL EXECUTION MODEL FOR ONE MESSAGE

The following defines the EXACT sequence for processing a single incoming WhatsApp message. This model produces exactly 1 reply. Every rule is absolute.

### Execution Pipeline

```
STEP 0: RECEIVE
  - Express handler receives POST body
  - Send HTTP 200 to Meta/caller immediately (before any processing)
  - Extract: { phone, message_text, message_id? }
  - Normalize: message_lower = message_text.trim().toLowerCase()

STEP 1: DEDUPLICATION
  - If message_id is present AND already in dedup Set → STOP (no reply, no processing)
  - Add message_id to dedup Set (max 1000 entries, FIFO evict)
  - If no message_id (simple {phone, message} format) → skip dedup check

STEP 2: ACQUIRE PROCESSING LOCK
  - Check per-phone lock: if phone is currently being processed → queue this message
  - Set lock for this phone
  - On completion: release lock, process next queued message if any

STEP 3: LOAD SESSION
  - Read session from persistent store (Supabase bot_sessions or Redis)
  - If NOT FOUND: create fresh session { state: 'GREETING', data: {}, trace_id: newUUID() }
  - If FOUND: use existing session
  - Session read has 3s timeout; on failure → treat as NOT FOUND (safe fallback)

STEP 4: DETERMINE REPLY (synchronous, no I/O, no await)
  This step runs pure logic on session + message.
  Returns exactly: { reply: string, newState: string, newData: object, ingestionTrigger: string|null }

  Layer 1 — GLOBAL OVERRIDES (checked first, checked in order, first match wins)
    1a. RESTART CHECK: message_lower === one of ['hi','hello','hey','start','hii','helo']
        → reply = restart_message(session)
        → newState = has_partial_data ? 'ASK_RESUME' : 'GREETING'
        → no ingestionTrigger
    1b. SALES INTENT: message matches specific SALES phrases (see State Machine V2 for clean list)
        → reply = specialist_callback_message
        → newState = UNCHANGED
        → newData.request_call = true
        → ingestionTrigger = 'sales_intent'
    1c. POWER DETECTION: message matches strict eye power pattern (see State Machine V2)
        → reply = eligibility_response
        → newState = UNCHANGED
        → newData.concern_power = true
        → ingestionTrigger = 'power_detected'

  Layer 2 — STATE-SPECIFIC KNOWLEDGE (only if no global override matched AND state is knowledge-eligible)
    Knowledge-eligible states: GREETING, ASK_PERMISSION, ASK_RESUME, NAME, CITY, COMPLETE
    → detect knowledge intents from message
    → reply = build_knowledge_response(intents, session)
    → newState = UNCHANGED  ← STRICT RULE: knowledge never advances state
    → newData = set intelligence flags ONLY (interest_cost, concern_pain, etc.)
      STRICT RULE: knowledge layer NEVER modifies timeline, city, name, or any qualification field
    → ingestionTrigger = 'knowledge' (only if intents detected)

  Layer 3 — STATE MACHINE (only if no override and no knowledge match)
    Execute current state handler
    → reply = state_reply
    → newState = next_state (see State Machine V2)
    → newData = captured qualification field
    → ingestionTrigger = 'update' (or null if GREETING/ASK_PERMISSION)

  FALLBACK (if nothing matched):
    → reply = fallback_message (static)
    → newState = UNCHANGED
    → ingestionTrigger = null

STEP 5: COMMIT SESSION (before sending reply)
  - Write { state: newState, data: merged(session.data, newData), last_activity_at: now } to persistent store
  - 3s timeout on write
  - On write failure: log error with trace_id. DO NOT abort reply — still send reply.
  - Failure here means session state is stale on next message — acceptable, not catastrophic

STEP 6: EXECUTE ASYNC OPERATIONS (in parallel, both fire-and-forget after reply text is determined)
  Operation A — Send WhatsApp Reply:
    - POST to Meta Graph API
    - 3 retries: 500ms, 1s, 2s backoff
    - On 429: honor Retry-After header (max 10s wait)
    - After all retries fail: log structured error { trace_id, phone_last4, reply_preview }
    - NEVER generate a second reply on failure

  Operation B — Ingest to Backend (only if ingestionTrigger is not null):
    - POST /api/ingest-lead with x-bot-key
    - 3 retries: 2s, 4s, 8s backoff (not 5 retries × 40s — far too slow)
    - After all retries fail: write to pending_ingestion table in Supabase
    - NEVER generate a second reply on failure

  Both A and B fire in parallel: Promise.all([sendReply(), ingestLead()])

STEP 7: RELEASE LOCK
  - Release per-phone processing lock
  - If messages were queued for this phone, process next one
```

### Strict Rules (Non-Negotiable)

| Rule | Enforcement Point |
|------|------------------|
| 1 input → exactly 1 reply | Only Step 6-A sends a reply |
| Reply text determined before any I/O | Step 4 is pure sync |
| State advances exactly once per message | Step 5 is a single atomic write |
| Knowledge never advances state | Layer 2 hard constraint |
| Async operations never generate replies | Steps 6-A and 6-B are fire-and-forget |
| Timer callbacks (inactivity) only call ingest, never send reply | Inactivity timer → ingest only |
| Dedup check before all processing | Step 1 is first |
| Lock acquired before session read | Step 2 before Step 3 |

---

## SECTION 3 — SYSTEM RULES (HARD CONSTRAINTS)

These rules apply to the entire system, not just the chatbot.

### Chatbot Rules

```
RULE C1: Exactly one reply per incoming message. No exceptions.
RULE C2: Reply text is computed synchronously before any await.
RULE C3: State transitions happen exactly once per message. If no match → state unchanged.
RULE C4: Knowledge responses never modify qualification fields (city, name, timeline, etc.).
RULE C5: Only intelligence flags (interest_cost, concern_pain, etc.) are set in knowledge layer.
RULE C6: Inactivity timer fires ingest only. Never sends a WhatsApp message.
RULE C7: sendToAPI and sendWhatsAppReply run in parallel, never sequentially.
RULE C8: Per-phone processing lock prevents concurrent message handling.
RULE C9: Message dedup set prevents reprocessing of same message_id.
RULE C10: All secrets from env vars. No hardcoded values. Boot fails if secret missing.
```

### Backend Rules

```
RULE B1: /api/ingest-lead validates x-bot-key before any DB operation.
RULE B2: Upsert on phone_number conflict — always. Never insert + check.
RULE B3: /api/push-to-crm-form checks pushed_to_crm=true before Puppeteer. Skips already-pushed leads.
RULE B4: CRM push returns partial results — never fails entire batch for one lead's error.
RULE B5: /api/auth/login is rate-limited (max 10/IP/minute).
RULE B6: Backend /webhook endpoint disabled via env var (WEBHOOK_ENABLED=false).
```

### Dashboard Rules

```
RULE D1: All write operations (assignee, status, remarks) go through backend API, not direct Supabase.
RULE D2: Auth token stored in httpOnly cookie, not localStorage.
RULE D3: Leads table queries use column projection and pagination (max 200 rows per page).
RULE D4: CRM push button disabled for leads with pushed_to_crm=true (both UI and API guard).
```

### Cross-Service Rules

```
RULE X1: trace_id flows from chatbot session creation through all downstream calls.
RULE X2: All secrets are Railway env vars. No fallback values in code.
RULE X3: All services log JSON with: ts, service, level, trace_id, event, data.
RULE X4: No service makes synchronous calls that block the reply path.
RULE X5: Supabase is the single source of truth for lead data.
```

---

## SECTION 4 — WHAT IS CORRECT AND MUST NOT CHANGE

- Upsert-on-conflict (phone_number) for lead merging — correct pattern
- Manual CRM push gate — correct, prevents bad data in Refrens
- p-queue concurrency:3 with isolated browser contexts — correct model
- Three separate Railway services — correct service boundary design
- Supabase anon key for dashboard READS — correct, anon key is public by design
- State machine collecting exactly 4 fields (city, surgery city, insurance, timeline) — correct scope
- `parameters_completed` as qualification threshold — correct metric
