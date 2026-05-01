# PRODUCTION_IMPROVEMENT_PLAN.md
# Relive Cure — Master System Improvement Plan

Generated: 2026-05-01  
Based on: SYSTEM_CONTEXT_V2.md  
Mode: Design only. No code. No execution.

---

## PART 1 — CURRENT RISKS

Risks are listed per domain, grounded in code observations.

---

### 1.1 Webhook Architecture

**Risk A — Orphaned backend `/webhook` endpoint is a silent liability**  
The backend exposes `GET + POST /webhook` with the same `hub.verify_token` as the chatbot. If Meta is accidentally or intentionally reconfigured to point to the backend URL, the system degrades silently: chatbot state machine still runs (called by backend), but WhatsApp replies switch to `'Got it 👍'` fallback because the chatbot returns `HTTP 200` with no JSON body. Users receive the wrong reply. No error is surfaced. This failure mode is invisible in logs unless you know what to look for.

**Risk B — No enforcement of which service is the canonical Meta target**  
Both services pass Meta's verification handshake. There is no code or infra guard preventing double-registration.

---

### 1.2 Chatbot Reliability

**Risk C — Session loss on every Railway restart or redeploy**  
`sessions` is an in-memory object, hydrated from `sessions.json` on boot. `sessions.json` is on Railway's ephemeral filesystem. A deploy wipes all active conversations mid-flow. Users who were mid-funnel (e.g., at CITY state) restart from GREETING on their next message. This is invisible to the admin.

**Risk D — No session TTL / unbounded memory growth**  
Sessions are never expired or cleaned up. Every phone number that ever messaged creates a permanent entry. Over weeks/months, memory grows until Railway OOMs the container. No eviction policy exists.

**Risk E — WhatsApp reply sending is fire-and-forget with no retry**  
Chatbot's `sendWhatsAppReply` makes a single axios call. If Meta API returns 429, 5xx, or a network error, the error is logged and the reply is silently dropped. The user receives nothing. No retry, no fallback, no alert.

**Risk F — Inactivity timer fires after restart even for completed sessions**  
Sessions hydrated from disk have `inactivityTimer: null`. Timer state is not persisted. A session that was at `COMPLETE` on disk has its timer recreated on the next message. This is handled correctly by the `if session.state === "COMPLETE" return` guard in `resetInactivityTimer`, but sessions at non-terminal states that were mid-timer at restart will never fire their timeout ingestion.

**Risk G — `sendToAPI` failure is non-fatal but causes data loss**  
After 5 failed attempts, the chatbot logs `FINAL FAILURE` and continues. The session state advances (e.g., `session.state = 'CITY'`), but the lead data is never in the database. The session persists in memory/disk with `ingested = false`, but no recovery mechanism exists to retry it later.

**Risk H — Chatbot has no keep-alive mechanism**  
The backend self-pings every 4 minutes. The chatbot has no equivalent. Railway may sleep the chatbot container during low-activity periods. The first message after sleep hits a cold-starting container, which may cause the initial state machine processing to be slow or fail with a timeout from the caller (if anyone calls it synchronously).

---

### 1.3 Backend Ingestion

**Risk I — Two diverging copies of `ingestion.js`**  
`/Users/jaskiring/Relive cure v2/src/lib/ingestion.js` (used by backend) and `/Users/jaskiring/relive-cure-dashboard/src/lib/ingestion.js` (used by dashboard) are separate files that have already diverged: the backend version has more sophisticated intent scoring logic (`parameters_completed * 10 + HOT bonus + urgency bonus + request_call bonus`) while the dashboard version uses simpler logic (`parameters_completed` directly as score). Any future change to scoring made in one copy will not propagate to the other, causing silent inconsistency.

**Risk J — `/api/ingest-lead` has no rate limiting or per-phone deduplication window**  
The chatbot can call `/api/ingest-lead` many times in rapid succession for the same phone (one call per state transition). This is intentional and handled by upsert. However, there is no guard against a malformed chatbot, a retry storm, or a malicious actor calling this endpoint with `x-bot-key: RELIVE_BOT_SECRET` (which is hardcoded and visible in both repos) to spam the database.

**Risk K — `BOT_SECRET` is hardcoded in both repos as a plain string**  
`const BOT_SECRET = 'RELIVE_BOT_SECRET'` appears literally in `server/index.js` (backend) and `server.js` (chatbot). Anyone with read access to either repository can authenticate as the chatbot and ingest arbitrary data. It is not a Railway env var and cannot be rotated without a code deploy.

**Risk L — `CRM_API_KEY` has a hardcoded fallback that is visible in source**  
`const CRM_API_KEY = process.env.CRM_API_KEY || 'relive_crm_secure_key_2026'` — if the Railway env var is unset (e.g., during a new environment setup), the hardcoded value is used. This value is in source control.

---

### 1.4 CRM Pipeline

**Risk M — 10-second Puppeteer timeout is too tight for a multi-step browser flow**  
The per-lead flow requires: set cookies → navigate to `/app` → wait for sessionStorage token → navigate to form → org selector → stage dropdown → fill 7+ fields → assert → submit → wait for navigation. On a cold container or a slow Refrens response, 10 seconds is insufficient. Timeouts are silent failures from the dashboard's perspective (lead shows as "failed" with no actionable detail).

**Risk N — Singleton browser has no recovery logic**  
`browserInstancePromise` is set once and never reset. If Chrome crashes or hangs, subsequent calls to `getBrowser()` return the crashed promise, and every lead push fails with an opaque error. Recovery requires a full backend process restart (Railway redeploy).

**Risk O — Puppeteer session (`./puppeteer-session`) is ephemeral**  
Every backend Railway deploy wipes the Chrome user data directory. After a deploy, `REFRENS_COOKIES` must contain valid, non-expired session cookies. If they are stale, every CRM push fails. There is no alerting or pre-check for cookie validity. The failure message is `'__rt exchange failed or timed out'` which requires knowledge of the system to diagnose.

**Risk P — Failed CRM leads have no retry mechanism**  
When `processQueue` returns `{ success: false }` for a lead, that lead stays in Supabase with `pushed_to_crm = false`. The dashboard shows it as "Not Pushed" but gives no indication that a push was already attempted and failed. There is no retry queue, no failure timestamp, no failure reason stored in the database.

**Risk Q — No CRM push idempotency guard at the API level**  
The backend `/api/push-to-crm-form` does not check `pushed_to_crm` before executing Puppeteer. The dashboard has a client-side guard (`if (lead.pushed_to_crm) alert(...)`) in `handleSinglePush`, but the bulk `handleAutoPush` filters by `!l.pushed_to_crm` on the client. A direct API call bypassing the dashboard could double-push a lead.

---

### 1.5 Dashboard → Database Architecture

**Risk R — Dashboard writes directly to Supabase using anon key**  
Assignee, status, remarks, and bulk-assign operations bypass the backend entirely. This means:
1. No server-side authorization beyond Supabase RLS
2. No audit trail of who changed what (no backend log, no `updated_by` field)
3. Any RLS misconfiguration would expose or allow manipulation of all lead data
4. The token in `localStorage` (`crm_token`) has no bearing on these writes — an unauthenticated user with the anon key (visible in source code) can write directly to the database

**Risk S — Dashboard reads ALL leads with `SELECT *`**  
`supabase.from('leads_surgery').select('*')` fetches every column for every row. As the table grows, this query becomes slower and more expensive. There is no pagination, no column projection, and no index-awareness in the frontend query.

---

### 1.6 Security

**Risk T — Admin login has no brute-force protection**  
`POST /api/auth/login` performs a plain string comparison with no rate limiting, no lockout, no CAPTCHA, and no IP throttling. An attacker can enumerate credentials at unlimited speed.

**Risk U — Auth token stored in `localStorage`**  
`localStorage` is accessible to any JavaScript on the page. A XSS vulnerability (in any third-party dependency: recharts, lucide-react, date-fns) would expose `crm_token`. `httpOnly` cookies are not susceptible to XSS.

**Risk V — No token expiry or rotation**  
`CRM_API_KEY` is static and never expires. A leaked token gives permanent admin access until a manual Railway env var update + redeploy.

**Risk W — `hub.verify_token` is hardcoded and identical across both services**  
`'relive_verify_token_123'` appears literally in both `server/index.js` and chatbot `server.js`. This is not a security risk in itself (Meta verify tokens are not secret), but it is an architectural coupling that means both services could register as the same webhook.

---

### 1.7 Observability

**Risk X — No structured logging**  
All logging is `console.log` / `console.error` with ad-hoc string formatting. Logs cannot be queried, aggregated, or alerted on. Finding a specific lead's ingestion trace requires grepping across Railway log lines from three services with no correlation.

**Risk Y — No correlation ID across services**  
A single user message triggers: chatbot processing → chatbot `/api/ingest-lead` call → backend upsert → (later) backend `/api/push-to-crm-form` → Puppeteer. There is no shared trace ID. Debugging a failed CRM push for a specific lead requires manually correlating log lines by phone number and timestamp across two separate Railway services.

**Risk Z — No alerting on critical failures**  
`FINAL FAILURE` (chatbot ingestion), `__rt exchange failed` (Puppeteer auth), `Chrome missing` (browser launch), and `Supabase upsert failed` are all logged to console but never trigger any alert.

---

## PART 2 — PROPOSED FIXES

---

### Fix 1 — Remove or Gate the Backend `/webhook` Endpoint

**Addresses**: Risk A, Risk B

The backend's `GET + POST /webhook` should either be removed entirely or gated behind a feature flag or IP allowlist. If it is intended as a backup, add a `WEBHOOK_ENABLED=false` env var guard that returns `HTTP 503` when false. Document which URL is the active Meta webhook in a `DEPLOYMENT.md` file.

The `hub.verify_token` on the backend endpoint should also be changed to a different value (`BACKEND_WEBHOOK_VERIFY_TOKEN` env var) to prevent accidental Meta registration.

---

### Fix 2 — Move Session Storage to Supabase or Redis

**Addresses**: Risk C, Risk D, Risk F, Risk G

Replace the in-memory `sessions` object + `sessions.json` with a persistent external store. Options:

**Option A (recommended for current scale): Supabase table `bot_sessions`**  
Schema: `phone_number (PK), state, data (jsonb), last_activity_at, created_at`  
Reads on every message (one SELECT by phone). Writes on every state transition (one UPSERT).  
Eliminates: session loss on restart, disk dependency, memory growth.

**Option B: Redis (Upstash, Railway Redis add-on)**  
Faster reads/writes, built-in TTL support. Adds a dependency but is the industry standard for session state.

In either case, add a TTL: sessions inactive for 7 days should be automatically deleted.

---

### Fix 3 — Add Retry + Dead Letter Queue for WhatsApp Reply Sending

**Addresses**: Risk E

WhatsApp reply sending in the chatbot must be retried on failure. Design:
- 3 attempts with exponential backoff (500ms, 1s, 2s)
- On 429: respect `Retry-After` header if present; otherwise wait 5s
- After 3 failures: log structured error with `{ phone, reply, error }` — consider writing to a `failed_replies` Supabase table for manual review

Do not make reply sending block the state machine. Keep it async but make failure observable.

---

### Fix 4 — Move `BOT_SECRET` and All Hardcoded Secrets to Env Vars

**Addresses**: Risk K, Risk L, Risk W

Required changes:

| Current | Change to |
|---------|----------|
| `const BOT_SECRET = 'RELIVE_BOT_SECRET'` (hardcoded in 2 files) | `process.env.BOT_SECRET` with no fallback — crash on startup if missing |
| `CRM_API_KEY \|\| 'relive_crm_secure_key_2026'` | `process.env.CRM_API_KEY` with no fallback |
| `hub.verify_token = 'relive_verify_token_123'` (hardcoded) | `process.env.WEBHOOK_VERIFY_TOKEN` |

All three Railway services must be updated with the env vars before deploying the code change. The absence of a fallback is intentional — a missing secret should crash loudly at boot, not silently use a known value.

---

### Fix 5 — Add Server-Side Idempotency Guard on CRM Push

**Addresses**: Risk Q

Backend `/api/push-to-crm-form` must filter out leads where `pushed_to_crm = true` before executing Puppeteer, not just rely on the client. Before calling `processQueue`, query Supabase:

```
SELECT id FROM leads_surgery WHERE id IN (:ids) AND pushed_to_crm = true
```

Return those IDs as `skipped_leads` in the response. This prevents double-push via direct API calls or race conditions.

---

### Fix 6 — Increase Puppeteer Timeout and Add Browser Health Check

**Addresses**: Risk M, Risk N

- Increase per-lead timeout from 10s to 30s (token exchange + form fill + navigation is routinely 15–20s on a cold page)
- Add a `browserHealthCheck()` function: after each lead, verify `browser.isConnected()`. If false, reset `browserInstancePromise = null` so next call creates a fresh browser
- Add a pre-push cookie validity check: before processing any leads, navigate to `refrens.com/app` once, verify `__at` appears within timeout. If it fails, return early with `{ status: 'error', message: 'CRM auth failed — cookies expired' }` without burning Puppeteer against the full lead list

---

### Fix 7 — Add CRM Push Failure Tracking to Database

**Addresses**: Risk P

Add two columns to `leads_surgery`:
- `crm_push_attempts` (integer, default 0) — incremented on every push attempt
- `crm_push_last_error` (text, nullable) — stores last Puppeteer error message
- `crm_push_last_attempted_at` (timestamp, nullable)

Backend updates these fields on both success and failure. Dashboard surfaces the failure reason in the detail panel. This enables admin triage without reading Railway logs.

---

### Fix 8 — Consolidate `ingestion.js` into a Single Source

**Addresses**: Risk I

The dashboard's `src/lib/ingestion.js` is unused for the write path (dashboard only reads via Supabase client). The dashboard's copy of `ingestLead` is dead code — it exists but the dashboard never calls it for production writes. It should be deleted from the dashboard repo. The backend's `src/lib/ingestion.js` is the authoritative version. Remove the copy, document clearly that ingestion logic lives only in the backend.

---

### Fix 9 — Route All Dashboard Writes Through the Backend

**Addresses**: Risk R, Risk T (partial)

Assignee, status, and remarks updates from the Dashboard should go through backend API endpoints, not directly to Supabase. This means adding:

- `PATCH /api/leads/:id` — update assignee, status, remarks (auth: `x-crm-key`)
- `POST /api/leads/bulk-assign` — batch assignee update (auth: `x-crm-key`)

Benefits:
- Server-side audit logging (who changed what, when)
- Centralized authorization
- Allows future field-level validation or business rules without frontend deploys
- Eliminates dependency on Supabase anon key for write operations from dashboard

---

### Fix 10 — Add Rate Limiting to Auth and Ingestion Endpoints

**Addresses**: Risk T, Risk J

- `/api/auth/login`: max 10 requests per IP per minute. Return `HTTP 429` with `Retry-After` on breach.
- `/api/ingest-lead`: max 30 requests per phone number per minute. Prevents a chatbot retry storm from hammering the database.
- `/api/push-to-crm-form`: max 3 concurrent requests system-wide (already handled by p-queue, but add HTTP-level limiting too).

Use `express-rate-limit` middleware. Keep limits permissive enough for normal chatbot retry behavior (5 retries × 1 lead = 5 calls; max 30/min is safe).

---

### Fix 11 — Replace `localStorage` Token with `httpOnly` Cookie

**Addresses**: Risk U, Risk V

Replace `localStorage.setItem("crm_token", ...)` with a `Set-Cookie: crm_token=...; HttpOnly; Secure; SameSite=Strict` response header from the backend login endpoint. Frontend reads from cookie automatically — no JavaScript access needed.

Add token expiry: set cookie `Max-Age: 86400` (24 hours). Backend must validate expiry on each request. This requires the token to carry a timestamp or use a signed JWT.

---

### Fix 12 — Add Structured Logging and a Correlation ID

**Addresses**: Risk X, Risk Y

Define a log format used consistently across all three services:

```json
{
  "ts": "2026-05-01T12:00:00Z",
  "service": "chatbot|backend|dashboard",
  "level": "info|warn|error",
  "trace_id": "<uuid>",
  "phone": "<last4 only for PII>",
  "event": "state_transition|api_call|crm_push|reply_sent",
  "data": {}
}
```

`trace_id` generation:
- Chatbot generates a `trace_id` (UUID) when a session is created
- Passes `trace_id` as a header (`x-trace-id`) in every call to `/api/ingest-lead`
- Backend includes `x-trace-id` in all Supabase writes and CRM push logs
- Dashboard includes `trace_id` (from the lead record) in push requests

This enables cross-service log correlation by trace ID in Railway's log viewer.

---

### Fix 13 — Add a Chatbot Keep-Alive

**Addresses**: Risk H

Add a self-ping to the chatbot identical to the backend's: call `GET /health` every 4 minutes using `setInterval`. Gate it on a `RAILWAY_PUBLIC_DOMAIN` env var just like the backend. This prevents Railway from sleeping the chatbot container between messages.

---

### Fix 14 — Add Pagination and Column Projection to Dashboard Query

**Addresses**: Risk S

Replace `SELECT *` with:
- Explicit column list (exclude heavy/unused columns like `user_questions`, `bot_fallback` from the list view)
- Add `LIMIT 200` with cursor-based pagination for the table view
- Supabase supports `.range(from, to)` for pagination

This reduces query payload and render time as the lead table grows.

---

## PART 3 — PRIORITY ORDER

### P0 — Critical (Production reliability at risk today)

| # | Fix | Risk(s) addressed | Why P0 |
|---|-----|------------------|--------|
| 4 | Move secrets to env vars | K, L | BOT_SECRET in source = permanent credential exposure |
| 6 | Puppeteer timeout + browser health check | M, N | CRM push fails silently; browser crash locks system until redeploy |
| 2 | Persistent session storage | C, D | Every deploy wipes mid-conversation leads silently |
| 13 | Chatbot keep-alive | H | Chatbot sleep = missed first message, broken reply flow |
| 5 | Server-side CRM idempotency guard | Q | Double-push to Refrens creates duplicate CRM records |

### P1 — High (Significant reliability and security improvement)

| # | Fix | Risk(s) addressed | Why P1 |
|---|-----|------------------|--------|
| 1 | Remove/gate backend /webhook | A, B | Silent failure mode on misconfiguration |
| 3 | WhatsApp reply retry | E | Users receive no reply on transient Meta failures |
| 7 | CRM failure tracking in DB | P | Failed leads are invisible without Railway log access |
| 9 | Route writes through backend | R | Anon key writes = no audit trail, no server-side auth |
| 10 | Rate limiting on auth + ingestion | T, J | Auth brute force; ingestion spam |
| 11 | httpOnly cookie for auth token | U, V | localStorage token is XSS-exposed |
| 12 | Structured logging + trace ID | X, Y | Cross-service debugging requires log correlation |

### P2 — Standard (Scalability and maintainability)

| # | Fix | Risk(s) addressed | Why P2 |
|---|-----|------------------|--------|
| 8 | Consolidate ingestion.js | I | Prevents logic drift but no current prod impact |
| 14 | Pagination + column projection | S | Only becomes critical at ~1000+ leads |
| 3 (retry DLQ) | Failed reply DLQ table | E (extended) | Low frequency today; valuable at scale |

---

## PART 4 — IMPACT VS EFFORT

```
                    HIGH IMPACT
                         │
    Fix 2 (sessions) ────┤──── Fix 4 (secrets)
    Fix 6 (puppeteer)    │     Fix 13 (keepalive)
    Fix 1 (webhook)      │     Fix 5 (idempotency)
    Fix 7 (CRM failures) │
                         │
LOW EFFORT ──────────────┼────────────────── HIGH EFFORT
                         │
    Fix 14 (pagination)  │     Fix 9 (route writes)
    Fix 8 (consolidate)  │     Fix 12 (tracing)
                         │     Fix 11 (httpOnly cookie)
                         │     Fix 3 (reply retry)
                         │     Fix 10 (rate limiting)
                    LOW IMPACT
```

**Highest ROI first** (high impact, low effort):
1. Fix 13 — Chatbot keep-alive: 10 lines of code, immediate reliability improvement
2. Fix 4 — Secrets to env vars: Railway config change + small code change, critical risk eliminated
3. Fix 5 — Idempotency guard: one DB query added before Puppeteer, prevents duplicate CRM records
4. Fix 6 (partial) — Increase Puppeteer timeout from 10s to 30s: one-line change, meaningful improvement

**Highest effort, highest long-term value**:
- Fix 2 (session persistence to Supabase): architectural change, eliminates the most systemic reliability risk
- Fix 9 (writes through backend): architectural shift, enables audit trail

---

## PART 5 — WHAT NOT TO CHANGE

The following design decisions are correct and should NOT be modified:

**1. Upsert-on-conflict strategy for ingestion**  
Using `phone_number` as the unique conflict key with `ignoreDuplicates: false` is the right pattern for incremental lead enrichment. Multiple chatbot calls merging data into one row is intentional and works correctly. Do not add per-call deduplication that would break incremental updates.

**2. Manual CRM push (admin-triggered only)**  
The decision to never auto-push to CRM on webhook receipt is architecturally sound. Auto-push produces incomplete records (no name, no assignee). The manual push gate ensures data quality. This must not change.

**3. p-queue with concurrency: 3 for CRM**  
The concurrency model is appropriate. p-queue with isolated browser contexts is the correct approach for parallel Puppeteer work. Do not replace with a single-threaded queue or increase concurrency beyond 3 without testing Refrens rate limits.

**4. Service separation (chatbot / backend / dashboard)**  
Three separate Railway services with clear responsibility boundaries is correct. Do not merge services to "simplify deployment." The separation allows independent scaling and independent deploy cycles.

**5. Supabase as the database**  
Supabase is appropriate for this scale and provides built-in realtime subscriptions, which the dashboard relies on. Do not migrate to a different database.

**6. Supabase anon key for dashboard READS**  
The dashboard reading directly from Supabase with the anon key (subject to RLS) is acceptable for the read path. The concern (Risk R) is specifically about WRITES. Read access does not require backend proxying.

**7. The chatbot state machine flow (GREETING → COMPLETE)**  
The state machine design is sound. The 8-state flow collects exactly the right data for lead qualification. The knowledge base responses and intelligence flag detection are value-adds that work correctly.

**8. Vite + React dashboard**  
The dashboard tech stack is appropriate. Do not add server-side rendering.

---

## EXECUTION SEQUENCE (RECOMMENDED)

If implementing this plan, work in this order to minimize risk:

**Week 1 — Stop the bleeding (P0)**
1. Fix 13: Add chatbot keep-alive (one interval call)
2. Fix 4: Move BOT_SECRET, CRM_API_KEY, verify_token to env vars (Railway config + tiny code change)
3. Fix 5: Add server-side pushed_to_crm check before Puppeteer
4. Fix 6 (partial): Increase Puppeteer timeout to 30s

**Week 2 — Reliability (P0 + P1)**
5. Fix 6 (full): Browser health check + pre-push cookie validity check
6. Fix 1: Gate backend /webhook with env var
7. Fix 7: Add crm_push_attempts, crm_push_last_error, crm_push_last_attempted_at columns

**Week 3 — Architecture (P1)**
8. Fix 2: Migrate session storage to Supabase bot_sessions table
9. Fix 3: Add WhatsApp reply retry logic (3 attempts)
10. Fix 10: Add rate limiting to auth and ingestion endpoints

**Week 4+ — Security + Scale (P1 + P2)**
11. Fix 9: Add PATCH/bulk-assign backend endpoints, remove direct Supabase writes from dashboard
12. Fix 11: Replace localStorage token with httpOnly cookie
13. Fix 12: Add structured logging with trace IDs
14. Fix 8: Remove duplicate ingestion.js from dashboard
15. Fix 14: Add pagination to dashboard Supabase query

---

*End of PRODUCTION_IMPROVEMENT_PLAN.md*
