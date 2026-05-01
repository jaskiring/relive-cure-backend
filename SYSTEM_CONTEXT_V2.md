# SYSTEM_CONTEXT_V2.md
# Relive Cure — Corrected Production System Context

Generated: 2026-05-01  
Version: V2 — Corrects critical architecture error in V1  
Source: Local repository code + grounded against real API endpoints

---

## ⚠️ V1 CORRECTION NOTICE

V1 stated: **Meta → Backend → Chatbot**  
This was WRONG.

Correct architecture: **Meta → Chatbot → Backend**

The chatbot service at `https://lasik-whatsapp-bot-production.up.railway.app` is the **primary and first receiver** of all WhatsApp webhook events from Meta. The backend is never in the Meta webhook path for production traffic.

All sections below reflect the corrected architecture.

---

## 1. CORRECTED ARCHITECTURE DIAGRAM

```
WhatsApp User
    │
    │  (Meta sends webhook)
    ▼
POST https://lasik-whatsapp-bot-production.up.railway.app/webhook
    │
    │  Chatbot:
    │  1. Sends HTTP 200 to Meta immediately (required <5s)
    │  2. Processes message async via state machine
    │  3. Sends WhatsApp reply → Meta Graph API  [IF WHATSAPP_ACCESS_TOKEN set on chatbot]
    │  4. Calls backend /api/ingest-lead with full session data
    │
    ▼
POST https://relive-cure-backend-production.up.railway.app/api/ingest-lead
    Header: x-bot-key: RELIVE_BOT_SECRET
    │
    │  Backend:
    │  1. Validates x-bot-key
    │  2. Upserts lead into Supabase (service role key)
    │  3. Returns { status: 'success', action, lead_id }
    │
    ▼
Supabase leads_surgery  (upsert on phone_number conflict)
    │
    │  Dashboard polls + realtime subscription
    ▼
https://relive-cure-dashboard-production.up.railway.app
    │
    │  Admin:
    │  1. Reviews leads
    │  2. Sets assignee
    │  3. Clicks Push to CRM
    │
    ▼
POST https://relive-cure-backend-production.up.railway.app/api/push-to-crm-form
    Header: x-crm-key: <crm_token>
    │
    ▼
Backend → Puppeteer → Refrens CRM (headless Chrome)
    │
    ▼
Supabase: pushed_to_crm = true, status = 'PUSHED_TO_CRM'
```

---

## 2. BACKEND'S /webhook ENDPOINT — STATUS: NOT THE META TARGET

The backend (`server/index.js`) contains a `GET /webhook` and `POST /webhook` handler at  
`https://relive-cure-backend-production.up.railway.app/webhook`

This endpoint is **NOT** configured as the Meta webhook URL in production.

Evidence from code:

```javascript
// Backend POST /webhook calls the chatbot:
const botRes = await fetch('https://lasik-whatsapp-bot-production.up.railway.app/webhook', {
    method: 'POST',
    body: JSON.stringify({ phone, message: text }),
});
```

If Meta was sending to the backend, the backend would call the chatbot, and the chatbot's `POST /webhook` would receive `{phone, message}` (not a Meta payload). The chatbot returns `res.sendStatus(200)` immediately with no JSON body — so the backend would receive `"OK"` text, log a "Non-JSON response" warning, and fall back to `reply = 'Got it 👍'`.

**Conclusion**: The backend's `/webhook` is an existing code path, but it is **not** the live Meta webhook target. Meta is configured to send to the chatbot. The backend's webhook handler is either legacy code or a backup route.

Both services share the same `hub.verify_token = 'relive_verify_token_123'`.

---

## 3. SERVICE RESPONSIBILITIES (CORRECTED)

### Chatbot — PRIMARY RECEIVER
**URL**: `https://lasik-whatsapp-bot-production.up.railway.app`  
**Repo**: `/Users/jaskiring/git-projects/relive-cure-sync/lasik-whatsapp-bot`  
**Start**: `node server.js` (CommonJS, Express 4, port `process.env.PORT || 3001`)

Responsibilities:
1. **Receive** Meta webhook payloads (`POST /webhook`)
2. **Acknowledge** Meta with HTTP 200 immediately (before any processing)
3. **Run** the conversational state machine
4. **Send** WhatsApp replies directly via Meta Graph API (if `WHATSAPP_ACCESS_TOKEN` + `PHONE_NUMBER_ID` set)
5. **Call** backend `POST /api/ingest-lead` with full session data (5 retries)
6. **Persist** sessions to `sessions.json` (debounced 200ms)

The chatbot handles both payload formats:
- Meta webhook format: `{ entry: [...] }` — used when Meta sends directly
- Simple format: `{ phone, message }` — used for direct curl simulation / testing

### Backend — SECONDARY PROCESSOR (API + CRM)
**URL**: `https://relive-cure-backend-production.up.railway.app`  
**Repo**: `/Users/jaskiring/Relive cure v2`  
**Start**: `node server/index.js` (ESM, Express 5, port `process.env.PORT || 3000`)

Responsibilities:
1. **Receive** ingestion calls from chatbot (`POST /api/ingest-lead`)
2. **Upsert** leads into Supabase using service role key
3. **Authenticate** dashboard admin (`POST /api/auth/login`)
4. **Execute** Puppeteer CRM push (`POST /api/push-to-crm-form`)
5. **Delete** leads (`DELETE /api/leads/:id`)
6. **Serve** `/health` for keep-alive pings

Does NOT (in the correct architecture):
- Receive WhatsApp webhooks from Meta (not the configured Meta target)
- Send WhatsApp replies in the live production message path
- Auto-trigger CRM push on ingest

### Dashboard — ADMIN INTERFACE
**URL**: `https://relive-cure-dashboard-production.up.railway.app`  
**Repo**: `/Users/jaskiring/relive-cure-dashboard`  
**Build**: Vite 8 static SPA (React 19)

Responsibilities:
1. **Read** leads from Supabase directly (anon key, hardcoded)
2. **Subscribe** to realtime changes + 8s polling
3. **Authenticate** via backend login
4. **Set** assignee and pipeline status
5. **Trigger** CRM push via backend
6. **Delete** leads via backend

### Supabase — DATABASE
**Table**: `leads_surgery`  
**URL**: `https://mvtiktflaqdkukswaker.supabase.co`  
**Access**:
- Backend: service role key (bypasses RLS) — write path
- Dashboard: anon key (hardcoded in `src/lib/supabase.js`) — read/subscribe path
- Chatbot: no direct access

---

## 4. COMPLETE DATA FLOW WITH REAL ENDPOINTS

### Phase 1: Message Reception (Chatbot)

```
Meta → POST https://lasik-whatsapp-bot-production.up.railway.app/webhook
Body: { entry: [{ changes: [{ value: { messages: [{ from, text: { body } }] } }] }] }
```

Equivalent curl simulation:
```bash
curl -X POST https://lasik-whatsapp-bot-production.up.railway.app/webhook \
  -H "Content-Type: application/json" \
  -d '{"phone":"9999999999","message":"Hi I want LASIK"}'
```

Chatbot actions (async, after 200 is sent):

**Step 1**: Extract phone and message  
**Step 2**: Create or load session from `sessions` in-memory store  
**Step 3**: Check if returning user (GET `/api/check-lead/:phone`)  

```bash
curl "https://relive-cure-backend-production.up.railway.app/api/check-lead/9999999999" \
  -H "x-bot-key: RELIVE_BOT_SECRET"
```

**Step 4**: Run state machine  
**Step 5**: Send WhatsApp reply via Meta Graph API  
(Only if `WHATSAPP_ACCESS_TOKEN` + `PHONE_NUMBER_ID` set on chatbot Railway env; otherwise dry-run)

**Step 6**: Call backend to ingest lead

```bash
curl -X POST https://relive-cure-backend-production.up.railway.app/api/ingest-lead \
  -H "Content-Type: application/json" \
  -H "x-bot-key: RELIVE_BOT_SECRET" \
  -d '{
    "phone_number": "9999999999",
    "contact_name": "Test Lead",
    "city": "Delhi",
    "preferred_surgery_city": "Delhi",
    "timeline": "This month",
    "insurance": "No",
    "intent_level": "WARM",
    "intent_score": 3,
    "urgency_level": "medium",
    "interest_cost": false,
    "interest_recovery": false,
    "concern_pain": false,
    "concern_safety": false,
    "concern_power": false,
    "request_call": false,
    "last_user_message": "hi i want lasik",
    "ingestion_trigger": "update"
  }'
```

Backend response:
```json
{ "status": "success", "action": "upserted", "lead_id": "<uuid>" }
```

Chatbot retries this call up to 5 times with exponential backoff (4s, 8s, 12s, 16s, 20s) if it fails.

### Phase 2: Lead Storage (Backend → Supabase)

Backend's `/api/ingest-lead` executes `ingestLead(supabaseAdmin, payload)`:

- Upserts into `leads_surgery` with `onConflict: 'phone_number'`
- Recalculates `parameters_completed` (0–4, counts non-empty: city, insurance, preferred_surgery_city, timeline)
- Recalculates `intent_score` (parameters × 10 + HOT bonus + urgency + request_call bonuses)
- Derives or preserves `intent_level`
- Sets `last_activity_at` to now

Same phone number always maps to the same row. Chatbot calls this endpoint multiple times per conversation — each call merges new data into the same row.

### Phase 3: Dashboard View

Dashboard reads from Supabase directly (no backend involved):

```javascript
// src/lib/supabase.js — anon key hardcoded
const supabase = createClient(VITE_SUPABASE_URL, '<anon_key>');

// App.jsx — 8s polling + realtime subscription
supabase.from('leads_surgery').select('*').order('created_at', { ascending: false });
```

### Phase 4: Assignee Assignment (Dashboard → Supabase direct)

Admin selects from dropdown (REPS: Anjali, Deepak, Siddharth, Priyanka, Rahul):

```javascript
// App.jsx handleUpdateLead
supabase.from('leads_surgery').update({ assignee: 'Anjali' }).eq('id', leadId)
```

This writes directly to Supabase using the anon key (subject to RLS). No backend call.

### Phase 5: CRM Push (Dashboard → Backend → Puppeteer → Refrens)

Admin verifies token exists, clicks "Push to CRM":

```bash
# First: get token via login
curl -X POST https://relive-cure-backend-production.up.railway.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# Response: { "success": true, "token": "<CRM_API_KEY>" }

# Then: push selected leads
curl -X POST https://relive-cure-backend-production.up.railway.app/api/push-to-crm-form \
  -H "Content-Type: application/json" \
  -H "x-crm-key: relive_crm_secure_key_2026" \
  -d '{
    "leads": [{
      "id": "test-id",
      "phone_number": "9999999999",
      "contact_name": "Test Lead",
      "city": "Delhi",
      "intent_level": "HOT",
      "assignee": "Anjali",
      "timeline": "This month",
      "insurance": "No",
      "source": "whatsapp_bot",
      "last_user_message": "I want LASIK",
      "remarks": ""
    }]
  }'
```

Backend constraint: max 20 leads per call.

Backend response on success:
```json
{
  "status": "success",
  "processed": 1,
  "success_count": 1,
  "failed_count": 0,
  "failed_leads": []
}
```

On success: backend updates Supabase:
```sql
UPDATE leads_surgery
SET pushed_to_crm = true, status = 'PUSHED_TO_CRM'
WHERE id IN (<successful_ids>)
```

### Phase 6: Webhook Verification (Meta Setup)

Meta calls this to register the webhook:
```bash
curl "https://lasik-whatsapp-bot-production.up.railway.app/webhook?\
hub.mode=subscribe&\
hub.verify_token=relive_verify_token_123&\
hub.challenge=TEST123"
# Expected response: TEST123  (echoes challenge)
```

---

## 5. WHERE THINGS HAPPEN (CORRECTED OWNERSHIP)

| Action | Owner | Mechanism |
|--------|-------|-----------|
| Receive WhatsApp webhook from Meta | **Chatbot** | `POST /webhook` |
| Acknowledge Meta within 5s | **Chatbot** | `res.sendStatus(200)` (immediate) |
| Run state machine / conversation | **Chatbot** | In-memory sessions + `sessions.json` |
| Send WhatsApp reply to user | **Chatbot** | Direct Meta Graph API call (if tokens set) |
| Ingest lead into database | **Backend** | `POST /api/ingest-lead` ← called by chatbot |
| Upsert to Supabase | **Backend** | Service role key, `src/lib/ingestion.js` |
| Read leads in dashboard | **Dashboard** | Direct Supabase anon key |
| Set assignee | **Dashboard → Supabase** | Direct anon key update (no backend) |
| Set status | **Dashboard → Supabase** | Direct anon key update (no backend) |
| Bulk assign | **Dashboard → Supabase** | Batch update via anon key (no backend) |
| Push to CRM | **Dashboard → Backend → Puppeteer** | `POST /api/push-to-crm-form` |
| Mark lead as pushed | **Backend** | Updates `pushed_to_crm=true` after Puppeteer |
| Delete lead | **Dashboard → Backend** | `DELETE /api/leads/:id` with `x-crm-key` |
| Admin auth | **Dashboard → Backend** | `POST /api/auth/login` |

---

## 6. API ENDPOINT REFERENCE (GROUNDED)

### Chatbot Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/webhook` | hub.verify_token | Meta webhook verification |
| `POST` | `/webhook` | None | Receives Meta payload OR `{phone, message}` |
| `GET` | `/health` | None | Returns `{status, version}` |

### Backend Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | `{status, node, ts, uptime}` |
| `GET` | `/test-db` | None | Debug: tests Supabase connection |
| `POST` | `/api/auth/login` | Credentials in body | Returns `CRM_API_KEY` as token |
| `POST` | `/api/ingest-lead` | `x-bot-key: RELIVE_BOT_SECRET` | Upserts lead from chatbot |
| `GET` | `/api/check-lead/:phone` | `x-bot-key: RELIVE_BOT_SECRET` | Checks if phone exists in DB |
| `POST` | `/api/push-to-crm-form` | `x-crm-key: <token>` | Pushes up to 20 leads to Refrens |
| `DELETE` | `/api/leads/:id` | `x-crm-key: <token>` | Hard-deletes a lead |
| `GET` | `/api/export-refrens-cookies` | `x-crm-key: <token>` | Exports current Puppeteer cookies |
| `GET` | `/webhook` | hub.verify_token | Webhook verification (legacy/backup) |
| `POST` | `/webhook` | None | Webhook handler (legacy/backup, not Meta target) |

---

## 7. CHATBOT STATE MACHINE

### States and Transitions

```
(new user, first message)
        │
        ▼
    GREETING ──────────────────────────────────────── sendToAPI("initial")
        │ [any reply]
        ▼
  ASK_PERMISSION
        │ [yes/ok/haan/sure]          [no/anything else]
        ▼                                     ▼
      NAME ─── sendToAPI("update")       COMPLETE (knowledge only)
        │ [valid name]
        ▼
      CITY ─── sendToAPI("update")
        │ [city]
        ▼
  SURGERY_CITY ─── sendToAPI("update")
        │ [city]
        ▼
   INSURANCE ─── sendToAPI("update")
        │ [answer]
        ▼
    TIMELINE ─── sendToAPI("update") ── COMPLETE

(existing lead found via GET /api/check-lead/:phone)
        │
        ▼
    RETURNING ──────────────────────────────────── sendToAPI not called (already ingested)
        │ [any message]
        ▼
     COMPLETE

(re-enters with hi/hello after partial data collected)
        │
        ▼
    ASK_RESUME
        │
        ▼
  ASK_PERMISSION (with _resuming=true)
        │ [yes] → skips to first missing field
        │ [no]  → COMPLETE
```

### State Machine Overrides (checked BEFORE state transitions)

Evaluated in this exact order per message:

1. **SALES_INTENT** — keywords: call, specialist, doctor, consultation, appointment, callback, etc.
   - Sets `request_call = true`
   - Calls `sendToAPI("update")`
   - Sends specialist callback message
   - Returns early (no state change)

2. **POWER DETECTION** — regex `/-?\d+(\.\d+)?/` matches eye power values
   - Sets `concern_power = true`
   - Calls `sendToAPI("update")`
   - Sends eligibility response
   - Returns early (no state change)

3. **TIMELINE STATE OVERRIDE** — if current state is `TIMELINE`
   - Captures message as `session.data.timeline`
   - Advances to `COMPLETE`
   - Calls `sendToAPI("update")`
   - Returns early

4. **KNOWLEDGE RESPONSE** — intents: RECOVERY, PAIN, ELIGIBILITY, REFERRAL, COST, TIMELINE, SAFETY
   - Only active in: `GREETING`, `ASK_PERMISSION`, `ASK_RESUME`, `NAME`, `CITY`, `COMPLETE`
   - Calls `sendToAPI("knowledge")`
   - Returns early

### sendToAPI Trigger Values

| Trigger | When fired |
|---------|-----------|
| `"initial"` | First message from new user (session just created) |
| `"update"` | After name, city, surgery city, insurance, timeline captured; also on sales intent, power detection |
| `"knowledge"` | After responding to an info question (COST, RECOVERY, etc.) |
| `"timeout"` | 2-minute inactivity timer fires |
| `"complete"` | (reserved, not currently in active use in code) |

---

## 8. INGESTION FLOW DETAILS

### Multiple Ingestion Calls per Conversation (Normal)

The chatbot calls `sendToAPI` multiple times per conversation — once when session is created and again after each piece of data is collected. Since the backend upserts on `phone_number` conflict, each call merges new data into the same row. This is intentional: it ensures partial lead data is captured even if the user abandons mid-flow.

Typical sequence for a full flow:
```
Message 1 (hi)           → sendToAPI("initial")    → row created
Message 3 (yes)          → [name question sent, no API call]
Message 4 (name)         → sendToAPI("update")     → contact_name added
Message 5 (city)         → sendToAPI("update")     → city added
Message 6 (surgery city) → sendToAPI("update")     → preferred_surgery_city added
Message 7 (insurance)    → sendToAPI("update")     → insurance added
Message 8 (timeline)     → sendToAPI("update")     → timeline added, COMPLETE
```

### Ingestion Deduplication

The backend has NO per-request deduplication for `/api/ingest-lead`. Deduplication is achieved only at the DB level via `onConflict: 'phone_number'`. The chatbot's own `session.ingested` flag is tracked but does not block API calls.

The backend's `/webhook` endpoint (legacy) has in-memory deduplication on `message.id` (max 500). This does NOT apply to `/api/ingest-lead` calls.

---

## 9. WHERE WHATSAPP REPLIES ARE SENT FROM

**In the correct architecture (Meta → Chatbot):**

WhatsApp replies are sent by the **chatbot**, directly calling Meta Graph API:
```
POST https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
Body: { messaging_product: "whatsapp", to: phone, type: "text", text: { body: reply } }
```

Guard in chatbot `sendWhatsAppReply`:
```javascript
if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.PHONE_NUMBER_ID) {
  console.log('[WA SEND DRY RUN]', phone, '->', reply);
  return;  // does NOT send — logs only
}
```

**If `WHATSAPP_ACCESS_TOKEN` is NOT set on the chatbot Railway service**: replies are dry-run only (logged, not sent). This would be a misconfiguration.

**The backend also has its own `sendWhatsAppReply` function** (used only if the backend's `/webhook` endpoint receives traffic — which it does not in the correct architecture).

---

## 10. ASSIGNEE HANDLING

| Step | Service | Mechanism |
|------|---------|-----------|
| 1. Not set by chatbot | — | Chatbot never touches `assignee` field |
| 2. Admin selects | Dashboard | Dropdown in lead detail panel → `handleUpdateLead(id, {assignee})` |
| 3. Stored | Supabase | Direct anon-key update: `UPDATE leads_surgery SET assignee = 'Anjali' WHERE id = ...` |
| 4. Bulk assign | Dashboard | `UPDATE leads_surgery SET assignee = X WHERE id IN (filtered_ids)` |
| 5. CRM push | Backend | Injected as TEXT in notes textarea: `Assignee: {lead.assignee \|\| 'Unassigned'}` |
| 6. In CRM | Refrens | Appears in Notes/Details field — NOT via any CRM dropdown |

Assignee is **never set automatically**. If a lead is pushed before an admin assigns it, CRM notes show `Assignee: Unassigned`.

---

## 11. AUTH SYSTEM

### Admin Login Flow

```bash
POST https://relive-cure-backend-production.up.railway.app/api/auth/login
Body: { "username": "<VITE_ADMIN_USERNAME>", "password": "<VITE_ADMIN_PASSWORD>" }

# Response on success:
{ "success": true, "token": "<CRM_API_KEY_value>" }

# Response on failure:
HTTP 401  { "success": false, "message": "Invalid credentials" }
```

Note: Despite the `VITE_` prefix, `VITE_ADMIN_USERNAME` and `VITE_ADMIN_PASSWORD` are **backend** Railway env vars. The prefix is a naming artifact. These values are never exposed to the frontend bundle.

### Token Usage

Token returned from login = the value of `CRM_API_KEY` env var (fallback: `relive_crm_secure_key_2026`).

Dashboard stores it: `localStorage.setItem("crm_token", data.token)`  
Dashboard uses it in headers: `x-crm-key: <crm_token>`

### Bot Auth (Chatbot → Backend)

Both services hardcode the same constant:
```javascript
const BOT_SECRET = 'RELIVE_BOT_SECRET';  // same string in both repos
```

This is NOT an env var. It is a plain hardcoded string literal in both codebases.

---

## 12. ENVIRONMENT MODEL

### Chatbot (Railway env)

| Variable | Required | Purpose |
|----------|----------|---------|
| `WHATSAPP_ACCESS_TOKEN` | YES (for live replies) | Meta Graph API bearer token |
| `PHONE_NUMBER_ID` | YES (for live replies) | WhatsApp Business phone number ID |
| `PORT` | No | Default: 3001 |

If `WHATSAPP_ACCESS_TOKEN` or `PHONE_NUMBER_ID` are absent, chatbot enters dry-run mode for replies — state machine and ingestion still work, but no WhatsApp messages are sent.

### Backend (Railway env)

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | YES | Supabase instance URL |
| `SUPABASE_SERVICE_ROLE_KEY` | YES | Admin DB access (bypasses RLS) |
| `CRM_API_KEY` | Recommended | Auth token for dashboard (fallback: `relive_crm_secure_key_2026`) |
| `REFRENS_COOKIES` | YES for CRM push | JSON array or JWT for Puppeteer session auth |
| `WHATSAPP_ACCESS_TOKEN` | Only if backend /webhook used | Meta token (legacy path) |
| `PHONE_NUMBER_ID` | Only if backend /webhook used | Phone ID (legacy path) |
| `VITE_ADMIN_USERNAME` | Recommended | Admin login username (default: `admin`) |
| `VITE_ADMIN_PASSWORD` | Recommended | Admin login password (default: `admin123`) |
| `RAILWAY_PUBLIC_DOMAIN` | Auto-set by Railway | Enables self-ping keep-alive |
| `PUPPETEER_SESSION_DIR` | No | Chrome profile dir (default: `./puppeteer-session`) |
| `PUPPETEER_CACHE_DIR` | No | Chrome binary cache |
| `CRM_FORM_URL` | No | Refrens form URL (default: `https://www.refrens.com/app/relivecure/leads/new`) |

### Dashboard (Vite VITE_* — baked into public bundle)

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase URL (safe to expose) |
| `VITE_CRM_API_URL` | Backend URL (fallback hardcoded in code) |

Supabase anon key is **hardcoded** in `src/lib/supabase.js` — intentionally, to avoid VITE_ env var misuse. Anon key is public by design.

---

## 13. SECURITY MODEL

### What Was Wrong Previously

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| `SUPABASE_SERVICE_ROLE_KEY` in frontend bundle | Placed in `VITE_*` env var → Vite baked it into `bundle.js` → committed to Git | Git history scrubbed via `git filter-repo`; key moved to backend-only Railway env |
| `crm_token` baked into frontend | Was a hardcoded constant in frontend code | Now fetched at runtime via `/api/auth/login` |

### Currently Enforced

- `SUPABASE_SERVICE_ROLE_KEY` only in Railway backend env, never in frontend
- `VITE_*` = public — only non-sensitive config
- Supabase anon key hardcoded in `src/lib/supabase.js` — safe, public by design
- Backend endpoints protected by `x-crm-key` (dashboard) or `x-bot-key` (chatbot)
- Chatbot uses `x-bot-key` header to authenticate with backend

### Current Residual Exposures

| Item | Risk Level | Notes |
|------|-----------|-------|
| `BOT_SECRET = 'RELIVE_BOT_SECRET'` hardcoded | Low (internal only) | Anyone with code access can see it; not an env var |
| `CRM_API_KEY` fallback `'relive_crm_secure_key_2026'` hardcoded | Low | Only used if env var not set on Railway |
| `hub.verify_token = 'relive_verify_token_123'` hardcoded | Low | In both services; not a secret by itself |
| Supabase anon key hardcoded | None | Intentional; public by design |

---

## 14. KNOWN CONSTRAINTS AND AMBIGUITIES

### Ambiguous: Are Both /webhook Endpoints Active?

Both the chatbot and backend expose `POST /webhook` with the same `hub.verify_token`. Meta can only be configured to send to ONE URL. Based on the user's correction, Meta sends to the chatbot. The backend's `/webhook` is not confirmed to receive Meta traffic in production.

**If Meta were ever reconfigured to point to the backend**: the backend would call the chatbot (simple `{phone, message}` format), get a `200 OK` text response (not JSON), log a warning, fall back to `'Got it 👍'`, send that reply, and separately ingest a minimal lead. The chatbot would process the state machine async but its WhatsApp send would be a dry-run (tokens likely only on chatbot).

### Ambiguous: Does Chatbot Have WHATSAPP_ACCESS_TOKEN?

If `WHATSAPP_ACCESS_TOKEN` and `PHONE_NUMBER_ID` are NOT set on the chatbot Railway service, all WhatsApp replies are dry-run only (logged, not sent). The state machine still runs and ingestion still happens. This would be a misconfiguration in production.

### Puppeteer Constraints

- 10-second per-lead timeout (hard)
- Singleton browser — crash requires process restart
- `./puppeteer-session` is ephemeral on Railway — Refrens login session lost on redeploy
- `REFRENS_COOKIES` must be kept fresh; stale cookies cause `__rt exchange failed`
- DOM selectors tied to Refrens UI — any Refrens update can break automation
- Max 20 leads per `/api/push-to-crm-form` call (enforced in backend)

### Session Persistence (Chatbot)

- Sessions are in-memory + `sessions.json`
- Railway service restart wipes all in-memory sessions (partially recovered from disk on next boot)
- No TTL/cleanup — sessions accumulate indefinitely
- 200ms debounced write — crash between event and write loses latest state

### Railway Keep-Alive (Backend only)

- Backend self-pings `GET /health` every 4 minutes via `RAILWAY_PUBLIC_DOMAIN`
- Chatbot has no keep-alive mechanism in code — subject to Railway sleep on inactivity
- Cold start latency (first request after sleep) may cause chatbot to miss or delay state processing

---

## 15. CURL VALIDATION FLOWS (COMPLETE)

### 1. Verify Chatbot Webhook Registration
```bash
curl "https://lasik-whatsapp-bot-production.up.railway.app/webhook?\
hub.mode=subscribe&hub.verify_token=relive_verify_token_123&hub.challenge=TEST123"
# Expected: TEST123
```

### 2. Simulate WhatsApp Message to Chatbot
```bash
curl -X POST https://lasik-whatsapp-bot-production.up.railway.app/webhook \
  -H "Content-Type: application/json" \
  -d '{"phone":"9999999999","message":"Hi I want LASIK"}'
# Expected: HTTP 200 (empty body — chatbot acks immediately, processes async)
```

### 3. Check Backend Health
```bash
curl "https://relive-cure-backend-production.up.railway.app/health"
# Expected: { "status": "ok", "node": "v...", "ts": "...", "uptime": ... }
```

### 4. Directly Ingest a Lead (simulates chatbot calling backend)
```bash
curl -X POST https://relive-cure-backend-production.up.railway.app/api/ingest-lead \
  -H "Content-Type: application/json" \
  -H "x-bot-key: RELIVE_BOT_SECRET" \
  -d '{"phone_number":"9999999999","contact_name":"Test Lead"}'
# Expected: { "status": "success", "action": "upserted", "lead_id": "<uuid>" }
```

### 5. Admin Login
```bash
curl -X POST https://relive-cure-backend-production.up.railway.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# Expected: { "success": true, "token": "relive_crm_secure_key_2026" }
```

### 6. Push Lead to CRM
```bash
curl -X POST https://relive-cure-backend-production.up.railway.app/api/push-to-crm-form \
  -H "Content-Type: application/json" \
  -H "x-crm-key: relive_crm_secure_key_2026" \
  -d '{
    "leads": [{
      "id": "test-id",
      "phone_number": "9999999999",
      "contact_name": "Test",
      "city": "Delhi",
      "intent_level": "HOT",
      "assignee": "Anjali"
    }]
  }'
# Expected: { "status": "success", "processed": 1, "success_count": 1, ... }
```

### 7. Delete a Lead
```bash
curl -X DELETE https://relive-cure-backend-production.up.railway.app/api/leads/<lead_id> \
  -H "x-crm-key: relive_crm_secure_key_2026"
# Expected: { "success": true, "deleted": "<lead_id>" }
```

---

*End of SYSTEM_CONTEXT_V2.md*
