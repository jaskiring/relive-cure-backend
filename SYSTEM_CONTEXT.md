# SYSTEM_CONTEXT.md
# Relive Cure — Complete Production System Context

Generated: 2026-05-01  
Source: Local repository inspection only. No execution performed.

---

## 1. SYSTEM OVERVIEW

**Purpose**: Automated lead management pipeline for LASIK surgery consultations.  
Captures patient interest from WhatsApp, qualifies it through a conversational bot, stores the structured lead in a database, and allows admins to review and push qualified leads into a CRM (Refrens).

**High-Level Architecture**:

```
WhatsApp User
    │
    ▼ (Meta webhook)
Backend /webhook   ──────────────────────────────────────────────────────┐
    │  1. Ack 200 to Meta immediately                                     │
    │  2. Extract phone + message text                                    │
    │  3. Forward {phone, message} → Chatbot /webhook (10s timeout)      │
    │  4. Receive bot reply                                               │
    │  5. Send reply to user via Meta Graph API                          │
    │  6. Upsert lead → Supabase (leads_surgery)                         │
    │                                                                     │
    ▼                                                                     │
Chatbot /webhook                                                          │
    │  1. Run state machine on {phone, message}                          │
    │  2. Return {reply} to backend caller                               │
    │  3. Also calls backend /api/ingest-lead (with full session data)   │
    │     (5 retries, exponential backoff)                               │
    │                                                                     │
    └──────────────────────► Supabase leads_surgery (upsert on phone)   │
                                        │                                 │
                             Dashboard (React)                            │
                                        │  1. Reads via anon key        │
                                        │  2. Realtime subscription      │
                                        │  3. Admin sets assignee        │
                                        │  4. Admin clicks Push to CRM  │
                                        │                                 │
                                        ▼                                 │
                             Backend /api/push-to-crm-form ◄─────────────┘
                                        │
                                        ▼
                             Puppeteer → Refrens CRM
```

---

## 2. SERVICE BREAKDOWN

### 2a. Backend
- **Repo**: `/Users/jaskiring/Relive cure v2`
- **Entry point**: `server/index.js`
- **Runtime**: Node.js ESM (`"type": "module"`)
- **Framework**: Express 5
- **Port**: `process.env.PORT || 3000`
- **Key deps**: `express`, `cors`, `@supabase/supabase-js`, `puppeteer`, `p-queue`, `node-fetch`, `dotenv`
- **Roles**:
  1. Receive WhatsApp webhooks from Meta
  2. Forward messages to chatbot service
  3. Ingest leads into Supabase (service role)
  4. Authenticate dashboard admins
  5. Execute Puppeteer CRM push (Refrens)
  6. Mark leads as `pushed_to_crm = true` after success

### 2b. Chatbot
- **Repo**: `/Users/jaskiring/git-projects/relive-cure-sync/lasik-whatsapp-bot`
- **Entry point**: `server.js`
- **Runtime**: Node.js CommonJS
- **Framework**: Express 4
- **Port**: `process.env.PORT || 3001`
- **Key deps**: `express`, `axios`
- **Roles**:
  1. Receive `{phone, message}` payload forwarded from backend
  2. Run state machine to collect lead data
  3. Return `{reply}` to backend caller
  4. Independently call `/api/ingest-lead` on backend with full session data
  5. Persist sessions to disk (`sessions.json`) with debounced writes

### 2c. Dashboard
- **Repo**: `/Users/jaskiring/relive-cure-dashboard`
- **Entry point**: `src/App.jsx`
- **Runtime**: React 19 / Vite 8 (static SPA)
- **Key deps**: `react`, `recharts`, `lucide-react`, `@supabase/supabase-js`, `date-fns`
- **Roles**:
  1. Admin login via backend
  2. Display and filter all leads from Supabase (direct, anon key)
  3. Set assignee and pipeline status per lead
  4. Push leads to CRM (calls backend)
  5. Delete leads (calls backend)
  6. Export to CSV
  7. Real-time lead updates (Supabase subscription + 8s polling)

### 2d. Database (Supabase)
- **Provider**: Supabase (Postgres)
- **Instance**: `https://mvtiktflaqdkukswaker.supabase.co`
- **Table**: `leads_surgery`
- **Access modes**:
  - Backend: service role key (bypasses RLS) — server-side only
  - Dashboard: anon key (subject to RLS) — hardcoded in `src/lib/supabase.js`
  - Chatbot: no direct access — goes through backend API

---

## 3. DEPLOYMENT STRUCTURE

All three services are deployed on **Railway** with GitHub-triggered deploys on push to `main`.

| Service   | Railway URL                                              | Start command          |
|-----------|----------------------------------------------------------|------------------------|
| Backend   | `https://relive-cure-backend-production.up.railway.app`  | `node server/index.js` |
| Chatbot   | `https://lasik-whatsapp-bot-production.up.railway.app`   | `node server.js`       |
| Dashboard | `https://relive-cure-dashboard-production.up.railway.app`| Static Vite build      |

**Backend postinstall**: `npx puppeteer browsers install chrome` — Chrome is installed into the container at build time.

**Session directory**: Puppeteer uses `./puppeteer-session` (or `process.env.PUPPETEER_SESSION_DIR`) to persist the Refrens login session across requests.

**Keep-alive**: Backend self-pings `GET /health` every 4 minutes (only if `RAILWAY_PUBLIC_DOMAIN` is set) to prevent Railway container sleep. First ping also lazy-imports the CRM automation module to pre-warm Puppeteer.

**Inter-service communication**:
- Backend → Chatbot: HTTP POST `https://lasik-whatsapp-bot-production.up.railway.app/webhook`
- Chatbot → Backend: HTTP POST `https://relive-cure-backend-production.up.railway.app/api/ingest-lead`
- Chatbot → Backend: HTTP GET `https://relive-cure-backend-production.up.railway.app/api/check-lead/:phone`
- Dashboard → Backend: HTTP POST/DELETE via `VITE_CRM_API_URL` (Railway env var, fallback hardcoded)
- Dashboard → Supabase: direct via JS client (anon key)
- Backend → Supabase: direct via JS client (service role key)
- Backend → Meta Graph API: `https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages`
- Backend → Refrens CRM: Puppeteer (headless Chrome)

---

## 4. COMPLETE DATA FLOW

### Step-by-step: WhatsApp message → CRM entry

```
1.  User sends WhatsApp message
        ↓
2.  Meta delivers webhook to: POST https://relive-cure-backend-production.up.railway.app/webhook
        ↓
3.  Backend immediately sends HTTP 200 to Meta (required within 5s)
        ↓
4.  Backend deduplication check: in-memory Set of message IDs (max 500 entries, FIFO evict)
    If duplicate → skip processing entirely
        ↓
5.  Backend extracts: phone = message.from, text = message.text.body
        ↓
6.  Backend calls chatbot: POST .../webhook  body: {phone, message: text}  timeout: 10s
        ↓
7.  Chatbot processes message through state machine
    → Returns {reply: "..."} to backend
    → ALSO independently POSTs to backend /api/ingest-lead with session data (async)
        ↓
8.  Backend sends WhatsApp reply via Meta Graph API (sendWhatsAppReply)
        ↓
9.  Backend upserts minimal lead (phone + last_user_message) into Supabase leads_surgery
    via ingestLead() using service role key
        ↓
10. [ASYNC] Chatbot's own sendToAPI() arrives at backend /api/ingest-lead
    with full session data (name, city, surgery city, insurance, timeline, intent scores, flags)
    → Upsert on phone_number conflict merges new fields into existing row
        ↓
11. Dashboard admin views leads in real-time (Supabase subscription + 8s poll)
        ↓
12. Admin sets assignee via detail panel dropdown
    → Stored in leads_surgery.assignee (Supabase direct update)
        ↓
13. Admin clicks "Push to CRM" (single or bulk, max 20)
    → Dashboard sends POST to backend /api/push-to-crm-form
      with: {leads: [...]} header: x-crm-key: <crm_token>
        ↓
14. Backend runs processQueue(leads) → p-queue with concurrency=3
    For each lead → processLead() via Puppeteer:
      a. Get singleton browser
      b. Create isolated browser context
      c. Set cookies from REFRENS_COOKIES env
      d. Navigate to refrens.com/app → exchange cookies for session token (__at)
      e. Navigate to lead creation form
      f. Select org (second .disco-select__control, first option)
      g. Select Stage dropdown (HOT→New, WARM→Open, COLD→Lost)
      h. Fill: name, phone (stripped +91), city, subject, notes textarea
      i. Notes contain: Assignee, Timeline, Insurance, Intent, Source, Last Message, Remarks
      j. Fill custom fields: surgery city, timeline, insurance
      k. Fill vendor phone field (input[name="vendorFields.1.value"])
      l. Assert name and phone fields have correct values
      m. Click submit button, wait for URL to change away from /new
      n. Close browser context
        ↓
15. Backend updates leads_surgery:
    SET pushed_to_crm = true, status = 'PUSHED_TO_CRM'
    WHERE id IN (successful lead IDs)
        ↓
16. Backend returns result to dashboard: {status, processed, success_count, failed_count, failed_leads}
```

---

## 5. CHATBOT STATE MACHINE

### States

| State          | Description                                              |
|----------------|----------------------------------------------------------|
| `GREETING`     | First contact — sends intro message, moves to ASK_PERMISSION |
| `ASK_PERMISSION` | Asks user consent to continue; on YES → NAME; on NO → COMPLETE fallback |
| `NAME`         | Collects contact name (validated); on valid → CITY     |
| `CITY`         | Collects current city; moves to SURGERY_CITY           |
| `SURGERY_CITY` | Collects preferred surgery city; "any" → stored as "Flexible"; moves to INSURANCE |
| `INSURANCE`    | Collects insurance status; moves to TIMELINE           |
| `TIMELINE`     | Collects surgery timeline; on any input → COMPLETE     |
| `COMPLETE`     | Terminal state for completed flows; knowledge Q&A still works |
| `RETURNING`    | Existing lead re-enters; greets by name; moves to COMPLETE |
| `ASK_RESUME`   | Returning user with partial data — asks to continue or skip |

### State Transitions (Happy Path)

```
NEW USER:
  (new session) → GREETING
  → [user replies] → ASK_PERMISSION
  → [yes] → NAME
  → [valid name] → CITY
  → [city] → SURGERY_CITY
  → [city] → INSURANCE
  → [answer] → TIMELINE
  → [any] → COMPLETE

RETURNING USER (existing lead in DB):
  (session created with existing=true) → RETURNING
  → [any message] → COMPLETE

RESTART (hi/hello/hey/start):
  If has collected name before → ASK_RESUME
  Else → GREETING (reset ingested=false)

RESUME FLOW (ASK_RESUME):
  → ASK_PERMISSION (with _resuming=true flag)
  → [yes] → skips to first missing field (SURGERY_CITY, INSURANCE, or TIMELINE)
  → [no] → COMPLETE
```

### Priority overrides (before state machine)

1. **SALES_INTENT** (`call`, `specialist`, `doctor`, `consultation`, etc.): sets `request_call=true`, sends specialist message, ingests update, returns early.
2. **POWER DETECTION** (regex `-?\\d+(\\.\\d+)?`): sets `concern_power=true`, sends eligibility message, returns early.
3. **TIMELINE STATE**: always captures message as timeline regardless of other intent when state = TIMELINE.
4. **KNOWLEDGE (GLOBAL)**: if `buildKnowledgeResponse` returns non-null AND current state is in `KNOWLEDGE_ALLOWED_STATES`, responds and returns early.

### Knowledge-allowed states
`GREETING`, `ASK_PERMISSION`, `ASK_RESUME`, `NAME`, `CITY`, `COMPLETE`  
(TIMELINE, SURGERY_CITY, INSURANCE are excluded — direct answer required)

### Intent Detection Priority Order
`RECOVERY → PAIN → ELIGIBILITY → REFERRAL → COST → YES → TIMELINE → SAFETY`

### Intelligence Flags Set During Conversation
- `interest_cost` → user asked about COST
- `interest_recovery` → user asked about RECOVERY
- `concern_pain` → user asked about PAIN
- `concern_safety` → user asked about SAFETY
- `concern_power` → user mentioned eye power value (numeric match)
- `request_call` → user triggered SALES_INTENT keywords

### Session Persistence
- **Runtime**: in-memory object `sessions = {}` (phone → session)
- **Startup**: hydrates from `sessions.json` on disk
- **Write**: debounced 200ms write to disk after any change (strips inactivityTimer)
- **Persisted fields**: `state`, `data`, `ingested`, `first_ingest_done`, `last_activity_at`

### Inactivity Timer
- 2-minute timeout per session (cleared and reset on each message)
- On fire: `sendToAPI(phone, session, "timeout")` — ingests partial data
- 30-minute follow-up placeholder logged (WhatsApp API call not yet implemented)

### Retry Logic (API ingestion)
- 5 attempts with exponential backoff: 4s, 8s, 12s, 16s, 20s
- On all 5 failures: logs critical error, session.ingested remains false

### Name Validation
- Min length: 3 characters
- Charset: letters + spaces only (no digits)
- Blacklist: `yes, ok, okay, haan, ha, no, nah, start, nahi, nope, sure, chalo, bilkul, haan ji, skip, next, continue`
- At least one word must be 3+ characters

---

## 6. BACKEND DESIGN

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Returns `{status, node, ts, uptime}` |
| `GET` | `/test-db` | None | Tests Supabase connection, returns sample row |
| `POST` | `/api/auth/login` | None (credentials) | Verifies username/password, returns CRM_API_KEY as token |
| `GET` | `/api/export-refrens-cookies` | `x-crm-key` | Exports current Puppeteer session cookies |
| `POST` | `/api/push-to-crm-form` | `x-crm-key` | Pushes lead array to Refrens CRM (max 20) |
| `POST` | `/api/ingest-lead` | `x-bot-key` | Upserts lead from chatbot into Supabase |
| `GET` | `/api/check-lead/:phone` | `x-bot-key` | Checks if phone exists in leads_surgery |
| `DELETE` | `/api/leads/:id` | `x-crm-key` | Hard-deletes lead by ID |
| `GET` | `/webhook` | Meta verify_token | WhatsApp webhook verification handshake |
| `POST` | `/webhook` | None | WhatsApp incoming messages from Meta |

### Ingestion Logic (`src/lib/ingestion.js`)

`ingestLead(supabaseClient, leadData)`:
1. Validates `phone_number` present
2. Computes `parameters_completed` (count of city, insurance, preferred_surgery_city, timeline that are non-empty)
3. Computes `intent_score` = `parameters_completed * 10` + HOT bonus (50) + urgency_level=high (20) + request_call (20)
4. Derives `intent_level` (priority: explicit `leadData.intent_level` → `intent_band` from bot → auto-calculated)
5. Auto-calculation: ≥3 params AND timeline contains "immediately" → hot; ≥2 params → warm; else → cold
6. Appends bot_fallback note to remarks if chatbot could not understand query
7. Upserts into `leads_surgery` with `onConflict: 'phone_number'` (updates existing row if phone already exists)
8. Sets `last_activity_at` to current timestamp on every upsert

### WhatsApp Webhook Processing

- Immediately returns 200 to Meta (must be within 5s or Meta retries)
- Deduplication: in-memory Set `processedMessageIds`, max 500, FIFO eviction
- Chatbot call has 10s AbortController timeout with fallback reply `'Got it 👍'`
- CRM push is **never** triggered automatically on webhook — only manual via Dashboard
- WhatsApp reply uses `node-fetch` (polyfilled at boot, overrides native fetch)
- Handles 429 rate limit responses gracefully (logs warning, does not retry)

---

## 7. CRM AUTOMATION PIPELINE

### Queue Configuration (`server/crm-automation.js`)

```javascript
const queue = new PQueue({
  concurrency: 3,      // max 3 leads processed simultaneously
  intervalCap: 6,      // max 6 tasks per interval
  interval: 10000      // interval = 10 seconds
});
```

### Browser Lifecycle

- **Singleton**: `browserInstancePromise` is a module-level promise — only ONE browser launched per process
- **Race-free**: uses promise pattern (`browserInstancePromise = (async () => {...})()`) to prevent parallel launches
- **Launch flags**: `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--memory-pressure-off`, `--js-flags=--max-old-space-size=256`
- **Session dir**: `./puppeteer-session` (Chrome profile — stores Refrens login state)
- **Chrome resolution**: custom cache → `puppeteer.executablePath()` → system paths → auto-install via `npx puppeteer browsers install chrome`

### Per-Lead Execution Flow

Each lead gets a **new isolated browser context** (`browser.createBrowserContext()`):

```
1.  Create browser context + new page
2.  Set REFRENS_COOKIES (from env, JSON array or JWT token)
3.  Navigate to https://www.refrens.com/app (waitForNavigation: domcontentloaded, 10s)
4.  Wait for sessionStorage.__at (access token) to appear (poll every 300ms, timeout 20s)
5.  Capture __at token, inject into new documents via evaluateOnNewDocument
6.  Navigate to CRM lead form: https://www.refrens.com/app/relivecure/leads/new
7.  Re-inject __at into current page sessionStorage
8.  Wait for .disco-select__control (org selector) to appear (10s)
9.  Click second .disco-select__control, select first option (org auto-select)
10. Select Stage dropdown by label keywords (stage/status/lead status/pipeline)
    HOT → "New", WARM → "Open", COLD → "Lost"
11. Fill input[name="contact.name"] with cleaned name
12. Fill input[name="contact.phone"] with phone (stripped +91/91 prefix)
13. Fill input[name="customer.city"] (fallback: "Delhi")
14. Fill input[name="subject"] with: "[TEST] LASIK Lead - {name} - {phone}"
15. Fill textarea[name="details"] with notes block:
      Assignee: {assignee or 'Unassigned'}
      Timeline: {timeline or 'N/A'}
      Insurance: {insurance or 'N/A'}
      Intent: {intent_level or 'N/A'}
      Source: {source or 'whatsapp_bot'}
      Last Message: {last_user_message or 'N/A'}
      Remarks: {remarks}  (if present)
16. Fill custom fields by label matching (surgery city, timeline, insurance)
17. Fill input[name="vendorFields.1.value"] with phone (vendor phone field)
18. Assert: contactName and contactPhone have correct values
19. Scroll submit button into view, click
20. Wait for page URL to change away from /new (navigation timeout: 10s)
21. If URL didn't change: check page body for validation errors, throw
22. Close browser context
```

### Timeout per Lead
- `withTimeout(processLead(lead), 10000)` — 10-second hard timeout per lead
- On timeout or error: returns `{ success: false, id: lead.id, error: message }`

### Field Fill Strategy
- `fillField()`: uses `waitForSelector(3s)`, clears via JS, types with `delay: 10ms`
- `fillCustomField()`: traverses DOM to find label, then fills adjacent input/textarea via JS
- `selectDropdownByLabel()`: finds label in DOM, clicks `.disco-select__control`, waits for options, matches by exact then partial text

### Cookie Authentication
- `parseCookies(REFRENS_COOKIES)`:
  - If JSON array (`[...]`) → direct use
  - If JWT string starting `eyJ` → wraps as single `__rt` cookie on `.refrens.com`
  - Null → no cookies set (will fail auth)

---

## 8. FIELD MAPPING

### Chatbot session.data → API payload → Supabase → CRM

| Chatbot field | API field sent | Supabase column | CRM destination |
|---------------|---------------|-----------------|-----------------|
| `contactName` | `contact_name` | `contact_name` | `input[name="contact.name"]` |
| `city` | `city` | `city` | `input[name="customer.city"]` |
| `surgeryCity` | `preferred_surgery_city` | `preferred_surgery_city` | Custom field: "surgery city" / "preferred city" |
| `insurance` | `insurance` | `insurance` | Custom field: "insurance" + notes |
| `timeline` | `timeline` | `timeline` | Custom field: "timeline" + notes |
| `interest_cost` | `interest_cost` | `interest_cost` | Not in CRM (notes only) |
| `interest_recovery` | `interest_recovery` | `interest_recovery` | Not in CRM (notes only) |
| `concern_pain` | `concern_pain` | `concern_pain` | Not in CRM |
| `concern_safety` | `concern_safety` | `concern_safety` | Not in CRM |
| `concern_power` | `concern_power` | `concern_power` | Not in CRM |
| `urgency_level` | `urgency_level` | `urgency_level` | Notes |
| `request_call` | `request_call` | `request_call` | Not in CRM |
| `intent_band` (scored) | `intent_level` | `intent_level` | Stage dropdown (HOT→New, WARM→Open, COLD→Lost) |
| `lastMessage` | `last_user_message` | `last_user_message` | Notes textarea |
| (phone from Meta) | `phone_number` | `phone_number` | `input[name="contact.phone"]` (stripped) |
| (Dashboard dropdown) | (not in chatbot) | `assignee` | Notes textarea |

### Lead Stage Mapping

| `intent_level` value | CRM Stage selected |
|---------------------|--------------------|
| `HOT` | New |
| `WARM` | Open |
| `COLD` | Lost |
| (missing/other) | New (fallback) |

### Parameters Completed Score
Counts how many of these 4 fields are non-empty: `city`, `insurance`, `preferred_surgery_city`, `timeline`  
Used for "Ready for CRM" filter (≥3) and intent auto-calculation.

---

## 9. ASSIGNEE HANDLING

| Step | Where | What happens |
|------|-------|-------------|
| 1. Selection | Dashboard detail panel | Admin picks from REPS dropdown: `['Anjali', 'Deepak', 'Siddharth', 'Priyanka', 'Rahul']` |
| 2. Storage | Supabase `leads_surgery.assignee` | Stored as plain text string via direct Supabase update (anon key, RLS) |
| 3. Bulk assign | Dashboard toolbar | Prompts for assignee name, batch-updates all filtered leads via Supabase |
| 4. CRM push | Backend `processLead()` | Injected into the Notes/Details textarea as line: `Assignee: {lead.assignee or 'Unassigned'}` |
| 5. NOT used | CRM UI | No dropdown interaction for assignee — purely text in notes |

**Key constraint**: Assignee is NEVER auto-populated by the chatbot. It only exists after a Dashboard admin manually selects it. If a lead is pushed to CRM before an assignee is set, it appears as "Assignee: Unassigned" in the CRM notes.

---

## 10. AUTH SYSTEM

### Login Flow

```
Dashboard Login Screen
    │  User enters username + password
    ▼
POST {backend}/api/auth/login
    Body: { username, password }
    │
    ▼ Backend verifies against:
    │  process.env.VITE_ADMIN_USERNAME (default: 'admin')
    │  process.env.VITE_ADMIN_PASSWORD (default: 'admin123')
    │
    ├─ Match → { success: true, token: CRM_API_KEY }
    └─ No match → 401 { success: false, message: 'Invalid credentials' }
    │
    ▼ Dashboard on success:
    localStorage.setItem("auth", "true")
    localStorage.setItem("crm_token", data.token)  // token = CRM_API_KEY value
```

### Token Usage (subsequent requests)

| Action | HTTP header | Verified against |
|--------|-------------|-----------------|
| Push to CRM | `x-crm-key: <crm_token>` | `process.env.CRM_API_KEY` |
| Delete lead | `x-crm-key: <crm_token>` | `process.env.CRM_API_KEY` |
| Export cookies | `x-crm-key: <crm_token>` | `process.env.CRM_API_KEY` |

### Bot Auth (chatbot → backend)

| Header | Value (hardcoded) |
|--------|------------------|
| `x-bot-key` | `RELIVE_BOT_SECRET` |

Both backend and chatbot use the same hardcoded string constant. This is **not** an env var — it's a literal in both codebases.

### Session Persistence
- Token stored in `localStorage` — persists across page refresh
- `auth=true` flag also stored — used to skip login screen on reload
- Logout: clears both `auth` and `crm_token` from localStorage

---

## 11. ENVIRONMENT MODEL

### Frontend (VITE_*) — baked into public bundle

| Variable | Purpose | Notes |
|----------|---------|-------|
| `VITE_SUPABASE_URL` | Supabase instance URL | Safe to expose |
| `VITE_CRM_API_URL` | Backend Railway URL | Safe; has hardcoded fallback |

Note: `VITE_ADMIN_USERNAME` and `VITE_ADMIN_PASSWORD` are listed in CONTEXT.md as frontend vars, but the actual verification is done on the backend using `process.env.VITE_ADMIN_USERNAME` / `process.env.VITE_ADMIN_PASSWORD` — these are Railway backend env vars with an unfortunate `VITE_` prefix naming.

The **Supabase anon key** is hardcoded directly in `src/lib/supabase.js` (not via env var) as a deliberate safety measure to prevent accidental VITE_ env var confusion. The anon key is considered public.

### Backend-only (Railway process.env) — never in frontend

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase URL for server-side client |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS — admin DB access |
| `CRM_API_KEY` | Auth token for Dashboard→Backend (fallback: `relive_crm_secure_key_2026`) |
| `REFRENS_COOKIES` | JSON array or JWT for Puppeteer session auth |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API bearer token |
| `PHONE_NUMBER_ID` | WhatsApp Business phone number ID |
| `VITE_ADMIN_USERNAME` | Admin login username (validated on backend) |
| `VITE_ADMIN_PASSWORD` | Admin login password (validated on backend) |
| `RAILWAY_PUBLIC_DOMAIN` | Auto-set by Railway; used for self-ping keep-alive |
| `PUPPETEER_SESSION_DIR` | Chrome user data dir (default: `./puppeteer-session`) |
| `PUPPETEER_CACHE_DIR` | Chrome binary cache path |
| `CRM_FORM_URL` | Refrens lead form URL (default: `https://www.refrens.com/app/relivecure/leads/new`) |

### Chatbot env vars

| Variable | Purpose |
|----------|---------|
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API bearer token (optional; dry-run if absent) |
| `PHONE_NUMBER_ID` | WhatsApp Business phone number ID (optional; dry-run if absent) |
| `PORT` | Server port (default: 3001) |

---

## 12. SECURITY MODEL

### Previous Security Issues (Fixed)

| Issue | What happened | Fix applied |
|-------|--------------|-------------|
| Service role key leak | `SUPABASE_SERVICE_ROLE_KEY` was placed in a frontend `.env` file, causing Vite to embed it in `bundle.js` and commit it to Git | Git history scrubbed using `git filter-repo`; key moved to backend-only Railway env |
| Token hardcoded in frontend | `crm_token` was previously baked into frontend build | Redesigned: token fetched at login via `/api/auth/login`, stored only in `localStorage` |

### Currently Enforced Rules

- **NO** `SUPABASE_SERVICE_ROLE_KEY` in any frontend file or `VITE_*` variable
- **NO** sensitive secrets in Git repository (`.gitignore` updated to ban `.env` and `bundle.js`)
- **ALL** admin keys only in Railway environment variables
- **VITE_** prefix = treated as public — only non-sensitive config goes there
- Service role key used exclusively server-side for write operations
- Anon key used client-side (Dashboard) — subject to Supabase Row Level Security
- Backend API endpoints protected by `x-crm-key` or `x-bot-key` header validation

### Current Exposure Notes

- `BOT_SECRET = 'RELIVE_BOT_SECRET'` is hardcoded as a plain string constant in both backend (`server/index.js`) and chatbot (`server.js`). It is not a Railway env var. Anyone with code access can see it.
- `CRM_API_KEY` has a hardcoded fallback (`relive_crm_secure_key_2026`) in `server/index.js`. If `CRM_API_KEY` env var is not set on Railway, this fallback is used.
- Supabase anon key is hardcoded in `src/lib/supabase.js` — intentional and safe.

---

## 13. CURRENT SYSTEM BEHAVIOR

### What is working (as of code inspection)

- WhatsApp webhook receives Meta payloads and forwards to chatbot
- Chatbot state machine collects 4 key fields: city, surgery city, insurance, timeline
- Lead upsert on phone_number — same phone never creates duplicate rows
- Dashboard displays all leads with real-time updates
- Admin can set assignee from 5 predefined reps or custom bulk input
- Push to CRM executes Puppeteer flow against live Refrens form
- `pushed_to_crm=true` prevents re-push indicators in UI (guard check in `handleSinglePush`)
- Backend self-pings every 4 minutes to prevent Railway sleep
- Duplicate message deduplication via in-memory Set

### Observable Patterns

- Chatbot ingests multiple times per conversation (on name capture, city, surgery city, insurance, each "update" trigger), merging data incrementally via upsert
- Backend also ingests on every webhook message (minimal payload), creating early DB record before chatbot finishes
- Lead `intent_level` can change across upserts as more data arrives
- `parameters_completed` and `intent_score` are recalculated on every upsert
- CRM push is strictly manual — no automatic trigger exists in the codebase

---

## 14. KNOWN CONSTRAINTS

### Puppeteer / Refrens

- **10-second timeout per lead** — complex form interactions (slow page load, token exchange, form fill) must complete within 10s
- **Token exchange required** — must navigate to `refrens.com/app` first, wait for `__at` in sessionStorage, then navigate to form; cannot skip this step
- **URL change validation** — success is detected by URL moving away from `/new`; if Refrens changes routing, this breaks
- **Cookie expiry** — `REFRENS_COOKIES` must be kept fresh; stale cookies cause auth failure (`__rt exchange failed or timed out`)
- **DOM fragility** — form selectors (`input[name="contact.name"]`, `.disco-select__control`) are tied to Refrens internal structure; any Refrens UI update can break automation
- **Chrome on Railway** — Chrome is installed at build time via `postinstall`. If install fails, `ensureChrome()` falls back to system paths. Railway containers may have memory pressure affecting Chrome stability.
- **Singleton browser** — a crashed/hung browser instance requires a process restart to recover (no browser restart logic in current code)

### Railway

- **Container sleep** — mitigated by self-ping every 4 minutes. Cold start (first request after sleep) may cause Bot timeout warning in backend logs.
- **Ephemeral filesystem** — `puppeteer-session/` and `sessions.json` are on ephemeral Railway storage. A container restart or redeploy wipes session data. Refrens login must be re-established after each restart.
- **Memory limit** — Chrome is memory-intensive; `--js-flags=--max-old-space-size=256` constrains V8, `--memory-pressure-off` suppresses Chrome's own GC pressure; actual Railway memory limit depends on plan tier.

### Concurrency

- `p-queue concurrency: 3` — 3 leads can run CRM pushes simultaneously; max 20 per API call (enforced at `POST /api/push-to-crm-form`)
- Each concurrent push opens a separate browser context (isolated, no shared state)
- `intervalCap: 6` tasks per 10 seconds — rate limiter to avoid overwhelming Refrens

### WhatsApp

- Meta Graph API `429` responses are handled with a warning log but no retry; rate limits can cause missed replies
- `hub.verify_token = 'relive_verify_token_123'` is hardcoded in both backend and chatbot

### Chatbot Sessions

- Sessions are in-memory; a chatbot service restart loses all active sessions (partially mitigated by `sessions.json` hydration on startup)
- `sessions.json` debounced write is 200ms — a crash between message processing and write could lose the latest state update
- No session TTL/cleanup — old sessions accumulate in memory and on disk indefinitely

---

*End of SYSTEM_CONTEXT.md*
