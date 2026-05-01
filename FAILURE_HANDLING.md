# FAILURE_HANDLING.md
# Relive Cure — Complete Failure Handling Design

Generated: 2026-05-01  
Scope: All failure modes across chatbot, backend, and CRM pipeline.

---

## DESIGN PRINCIPLES

1. **No failure causes an additional reply** — user always receives exactly 1 reply or 0 replies (dedup)
2. **Failures are silent to the user but loud to the operator** — log everything
3. **Degraded operation is preferable to full stop** — partial data is better than no data
4. **Every failure has a defined fallback**, not an uncaught exception
5. **Critical path** (reply to user) is never blocked by non-critical path (ingest, CRM push)

---

## 1. BACKEND FAILURE (chatbot → /api/ingest-lead)

### Scenario: Backend is down, slow, or returns 5xx

```
Current behavior:
  5 retries × 40s timeout = up to 3.3 minutes before giving up
  On final failure: console.error("FINAL FAILURE"), session.ingested stays false
  No recovery mechanism

Designed behavior:
  Retry policy:
    Attempt 1: immediately (8s timeout)
    Attempt 2: 2s delay (8s timeout)
    Attempt 3: 4s delay (8s timeout)
    Total max time: ~24s
    (This is fire-and-forget — does not block reply)

  On attempt 1 success: log { event:'ingest_success', trace_id, lead_id }

  On all 3 attempts failed:
    Write to Supabase pending_ingestion table:
    {
      id: uuid,
      phone_number: phone,
      payload: jsonb,
      trigger: string,
      trace_id: string,
      failed_at: timestamp,
      retry_count: 3,
      last_error: error.message
    }
    Log: { level:'error', event:'ingest_all_retries_failed', trace_id, phone_last4 }

  Recovery path:
    A background job (cron or next-message trigger) reads pending_ingestion
    and retries the payload once the backend is healthy.
    On success: delete row from pending_ingestion.
```

### Scenario: Backend returns 401 (bad x-bot-key)

```
  This is a configuration error, not a transient failure.
  Do NOT retry.
  Log: { level:'critical', event:'ingest_auth_rejected', trace_id }
  Write to pending_ingestion with error='AUTH_REJECTED'
  Alert required — this means BOT_SECRET mismatch between chatbot and backend.
```

### Scenario: Backend returns 400 (bad payload)

```
  This is a code bug, not a transient failure.
  Do NOT retry.
  Log: { level:'error', event:'ingest_payload_rejected', trace_id, payload }
  Do NOT write to pending_ingestion (payload is malformed, retry won't help).
```

---

## 2. WHATSAPP API FAILURE (chatbot → Meta Graph API)

### Scenario: Meta returns 5xx

```
  Retry policy:
    Attempt 1: immediately
    Attempt 2: 500ms delay
    Attempt 3: 1000ms delay
    Total max time: ~2.5s (acceptable before session commit)

  On all 3 failed:
    Log: { level:'error', event:'reply_send_failed', trace_id, phone_last4,
           reply_preview: reply.slice(0,50), error }
    Write to failed_replies Supabase table:
    {
      phone_number: phone,
      reply_text: reply,
      trace_id: string,
      failed_at: timestamp,
      error: string
    }
    DO NOT send a second reply.
    DO NOT crash the process.
    User receives no reply for this message.
```

### Scenario: Meta returns 429 (rate limited)

```
  Read Retry-After header value (seconds).
  If Retry-After <= 10s: wait and retry once.
  If Retry-After > 10s: log and write to failed_replies (too long to wait inline).
  DO NOT block the event loop waiting longer than 10s.
```

### Scenario: Meta returns 400 (invalid phone / bad payload)

```
  Do NOT retry.
  Log: { level:'warn', event:'reply_rejected_by_meta', phone_last4, error }
  This likely means the phone number is invalid or not registered on WhatsApp.
```

### Scenario: WHATSAPP_ACCESS_TOKEN not set in env

```
  Chatbot detects this at reply-send time.
  Log: { level:'warn', event:'reply_dry_run', phone, reply_preview }
  Print reply to console (for dev/testing).
  Do not attempt API call.
  This is a deployment configuration issue — should be caught at startup.
```

---

## 3. SESSION STORE FAILURE

### Scenario: Session READ fails (Supabase timeout/error)

```
  Behavior: treat as "session not found" — create fresh GREETING session
  Log: { level:'error', event:'session_read_failed', phone_last4, error }
  User will restart from GREETING.
  This is acceptable — better than no reply.
  Data already in DB is not lost (next sendToAPI will upsert correctly).
```

### Scenario: Session WRITE fails after reply is determined

```
  Reply is already generated (Step 4 is sync).
  STILL send the reply.
  Log: { level:'error', event:'session_write_failed', trace_id, phone_last4 }
  
  Effect: session state is stale — user may get repeat questions on next message.
  Mitigation: on next message, if session state seems wrong (e.g., user provides
    data that was already collected), detect via data presence and skip re-asking.
  
  Do NOT abort the reply due to session write failure.
```

### Scenario: Session store is fully down (all reads and writes failing)

```
  System degrades to stateless mode:
    Every message → new GREETING session
    User always sees intro message
    Ingestion may still succeed (backend uses upsert, partial data is fine)
  
  Log: { level:'critical', event:'session_store_unavailable' }
  Alert required.
  User experience is degraded but not broken.
```

---

## 4. DUPLICATE WEBHOOK ARRIVES

### Scenario: Meta delivers same message_id twice

```
  Chatbot has message_id dedup Set (max 1000 entries, FIFO eviction).
  Second delivery: dedup check fires at Step 1 → STOP immediately.
  No processing, no state change, no additional reply.
  Log: { level:'info', event:'duplicate_message_skipped', message_id }
```

### Scenario: Two messages arrive with no message_id (simple format, rapid succession)

```
  Per-phone processing lock prevents concurrent execution.
  Second message enters Step 2 → phone is locked → message queued.
  First message completes → lock released → second message processed.
  Each message gets exactly one reply.
```

### Scenario: Inactivity timer fires simultaneously with a new message arriving

```
  Node.js event loop is single-threaded — true simultaneous execution is impossible.
  One of these executes first:
    If new message handler runs first:
      resetInactivityTimer(phone) clears the timer before it fires.
      Timer never fires. New message processed normally.
    If timer fires first:
      sendToAPI("timeout") called.
      New message arrives and resets the timer (timer is now null).
      New message processed normally with updated session.
  Either order: exactly one ingest call fires, exactly one reply is sent.
  No conflict.
```

---

## 5. CRM PIPELINE FAILURES

### Scenario: REFRENS_COOKIES are expired

```
  Pre-push check (before processing any leads):
    Navigate to refrens.com/app
    Wait for sessionStorage.__at (5s timeout)
    
    If __at does NOT appear:
      Return immediately: { status: 'error', message: 'CRM auth failed — cookies expired. Refresh REFRENS_COOKIES in Railway env.' }
      Do NOT process any leads.
      Do NOT mark any leads as failed (they haven't been attempted).
      Log: { level:'critical', event:'crm_auth_failed' }
```

### Scenario: Puppeteer times out on a single lead (30s timeout)

```
  processLead() throws TimeoutError.
  Queue wrapper catches it: return { success: false, id: lead.id, error: 'Timeout' }
  Backend updates Supabase for this lead:
    crm_push_attempts += 1
    crm_push_last_error = 'Timeout after 30s'
    crm_push_last_attempted_at = now
    pushed_to_crm stays false
  
  Other leads in the batch continue processing (partial success is valid).
  Response to dashboard: { success_count: X, failed_count: 1, failed_leads: [...] }
  Admin can retry the failed lead individually.
```

### Scenario: Chrome crashes during batch

```
  browser.isConnected() returns false.
  BrowserHealthCheck fires (after each lead): detects disconnected browser.
  Action: reset browserInstancePromise = null
  Next lead in queue: getBrowser() creates a new browser instance.
  Already-completed leads: already have their results (success or fail).
  In-progress lead at crash time: times out, returns { success: false, error: 'Browser disconnected' }.
  
  No full process restart required.
```

### Scenario: Form validation error on Refrens

```
  After submit, URL stays at /new AND page body contains 'is a required field'.
  processLead() throws: 'Form validation error on submit'
  Return: { success: false, id: lead.id, error: 'Form validation: required field missing' }
  Store in crm_push_last_error.
  This indicates a data mapping issue — admin must inspect the lead data.
```

### Scenario: Duplicate CRM push attempt (lead already pushed)

```
  Backend checks pushed_to_crm = true before processQueue().
  Any lead with pushed_to_crm = true is filtered out and added to skipped_leads.
  Response: { skipped_leads: [id1, id2], success_count: X, ... }
  Puppeteer is never invoked for already-pushed leads.
```

---

## 6. AUTH FAILURE

### Scenario: Dashboard sends wrong x-crm-key

```
  Backend returns 401 { error: 'Unauthorized: Invalid x-crm-key' }
  Dashboard shows auth error.
  No Supabase operations performed.
  No Puppeteer launched.
  Log: { level:'warn', event:'auth_rejected', ip: req.ip, endpoint }
```

### Scenario: Too many login attempts

```
  Rate limiter fires: 10 attempts per IP per minute.
  Backend returns 429 { error: 'Too many requests', retry_after: 60 }
  Log: { level:'warn', event:'rate_limit_auth', ip: req.ip }
```

### Scenario: Token expired (after httpOnly cookie implementation)

```
  Backend validates cookie expiry on every protected request.
  Expired token: return 401 with body { error: 'Session expired' }
  Dashboard: clear cookie, redirect to login screen.
  Not a system failure — expected lifecycle behavior.
```

---

## 7. STARTUP FAILURES

### Scenario: Required env var missing at boot

```
  Required vars (no fallback allowed):
    Backend: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRM_API_KEY,
             BOT_SECRET, WEBHOOK_VERIFY_TOKEN
    Chatbot: BOT_SECRET, WEBHOOK_VERIFY_TOKEN
    (WHATSAPP_ACCESS_TOKEN is NOT required to boot — just enables live replies)

  Behavior if missing:
    console.error('[BOOT CRITICAL] Missing required env var: {VAR_NAME}')
    process.exit(1)
    Railway will show the process as crashed and not route traffic.
  
  This is intentional — a misconfigured service should fail loudly at boot,
  not run silently with wrong behavior.
```

---

## 8. FAILURE OBSERVABILITY MATRIX

| Failure | User impact | Admin visibility | Alert? |
|---------|-------------|-----------------|--------|
| Backend down, ingest fails | None (reply still sent) | pending_ingestion table | No (auto-retry handles it) |
| Meta API 5xx, reply fails | No reply received | failed_replies table | No (low frequency) |
| Meta API 429 | Delayed or no reply | Log + failed_replies | No |
| Session read fails | User restarts from GREETING | Log error | No |
| Session write fails | User may get repeat question | Log error | No |
| Duplicate webhook | None | Log info | No |
| Refrens cookies expired | CRM push blocked | Error response to dashboard | YES (blocks all CRM) |
| Chrome crash | In-flight lead fails | crm_push_last_error in DB | No (browser auto-restarts) |
| Form validation error | Lead not in CRM | crm_push_last_error in DB | No (admin retries) |
| BOT_SECRET mismatch | All ingestion fails | Log critical + pending_ingestion AUTH_REJECTED | YES (all ingestion fails) |
| Missing required env var at boot | Full service down | Railway crash log | YES (Railway alerts on crash) |
| Session store fully down | All users see GREETING | Log critical | YES |
