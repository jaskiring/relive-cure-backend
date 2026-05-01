# STATE_MACHINE_V2.md
# Relive Cure — Improved Deterministic State Machine

Generated: 2026-05-01  
Design principles: no loops, exactly one transition per message, three clean layers.

---

## DESIGN PRINCIPLES

1. **Every state has exactly one valid successor** for each input category
2. **No state can transition to itself** (no self-loops, no repeated questions)
3. **Terminal states (COMPLETE, RETURNING_DONE) never transition except via RESTART**
4. **Knowledge layer is stateless** — it annotates data but never changes state
5. **Global overrides are stateless** — they set flags but never change state
6. **The state machine (Layer 3) is the only layer that advances state**
7. **Each state collects exactly one piece of data** — no multi-field states

---

## STATES

| State | Collects | Valid Successor(s) | Terminal? |
|-------|----------|--------------------|-----------|
| `GREETING` | nothing (intro only) | `ASK_PERMISSION` | No |
| `ASK_PERMISSION` | user consent | `NAME` (yes) or `COMPLETE` (no) | No |
| `NAME` | contact_name | `CITY` | No |
| `CITY` | city | `SURGERY_CITY` | No |
| `SURGERY_CITY` | preferred_surgery_city | `INSURANCE` | No |
| `INSURANCE` | insurance | `TIMELINE` | No |
| `TIMELINE` | timeline | `COMPLETE` | No |
| `ASK_RESUME` | (check missing fields) | `ASK_PERMISSION` (resume) or `COMPLETE` (skip) | No |
| `RETURNING` | nothing (greet only) | `COMPLETE` | No |
| `COMPLETE` | nothing (terminal) | only via RESTART → `GREETING` or `ASK_RESUME` | Yes |

---

## STATE HANDLERS (LAYER 3)

Each handler defines: input accepted, reply generated, state transition, data update.

---

### STATE: GREETING

```
Trigger: any message when state = GREETING

Action:
  newState = 'ASK_PERMISSION'
  reply = "Hi 👋 I'm the LASIK consultation assistant.\n\n
           We help patients connect with trusted eye hospitals.\n\n
           Shall I help you with a few quick details to guide you?"
  dataUpdates = {}
  ingestionTrigger = null

Note: No data collected here. No ingest needed.
      The "initial" sendToAPI call is REMOVED — nothing useful to send.
```

---

### STATE: ASK_PERMISSION

```
Case A: resuming = true (user returned via RESTART to ASK_RESUME → ASK_PERMISSION)
  Sub-case A1: message contains consent signal
    Consent signals: message_lower includes any of:
      ['yes', 'ok', 'okay', 'sure', 'haan', 'haan ji', 'bilkul', 'chalo']
    Action:
      Find first missing field in order: SURGERY_CITY → INSURANCE → TIMELINE
      newState = first missing field state
      reply = "Great! Let's continue 😊\n\n{next_field_question}"
      dataUpdates = {}
      ingestionTrigger = null
  Sub-case A2: no consent
    newState = 'COMPLETE'
    reply = "No problem! 😊 Feel free to ask me anything:\n• LASIK cost\n• Recovery time\n• Eligibility\n• Book consultation"
    dataUpdates = {}
    ingestionTrigger = null

Case B: normal (first time at permission)
  Sub-case B1: consent signal (same list as A1)
    newState = 'NAME'
    reply = "Great 👍 May I know your name?"
    dataUpdates = {}
    ingestionTrigger = null
  Sub-case B2: no consent
    newState = 'COMPLETE'
    reply = "No worries 😊\n\nYou can ask me about:\n• Cost\n• Recovery\n• Eligibility"
    dataUpdates = {}
    ingestionTrigger = null
```

---

### STATE: NAME

```
Input validation (isValidName):
  • length >= 3 after trim
  • only letters and spaces
  • not in blacklist: [yes, ok, okay, haan, ha, no, nah, start, nahi, nope,
                       sure, chalo, bilkul, haan ji, skip, next, continue]
  • at least one word >= 3 characters

Case A: valid name
  newState = 'CITY'
  firstName = message.trim().split(' ')[0]
  reply = "Nice to meet you, {firstName}! 😊\n\nWhich city are you based in? 📍"
  dataUpdates = { contactName: message.trim() }
  ingestionTrigger = 'update'

Case B: invalid name
  newState = 'NAME'  ← SAME STATE (one loop allowed — asking same question is not a flow loop)
  reply = "Could you please tell me your full name?"
  dataUpdates = {}
  ingestionTrigger = null
  
Note: NAME is the ONLY state that can stay on itself, and only once.
      After 2 failed attempts, accept any non-empty input as name.
      Track failed_name_attempts in session data.
      if failed_name_attempts >= 2 → accept message as name regardless of validation.
```

---

### STATE: CITY

```
Input: any non-empty message

Action:
  newState = 'SURGERY_CITY'
  firstName = data.contactName?.split(' ')[0] || ''
  prefix = firstName ? "Got it, {firstName} 👍\n\n" : ""
  reply = "{prefix}Which city would you prefer for surgery?\n(You can choose any city)"
  dataUpdates = { city: message.trim() }
  ingestionTrigger = 'update'

Note: No validation on city. Accept any answer.
      Empty message → handled by STEP 4 edge case (fallback reply, no state change).
```

---

### STATE: SURGERY_CITY

```
Input: any non-empty message

Action:
  stored_city = message_lower.includes('any') ? 'Flexible' : message.trim()
  newState = 'INSURANCE'
  firstName = data.contactName?.split(' ')[0] || ''
  prefix = firstName ? "Got it, {firstName} 👍\n\n" : ""
  reply = "{prefix}Do you have medical insurance?"
  dataUpdates = { surgeryCity: stored_city }
  ingestionTrigger = 'update'
```

---

### STATE: INSURANCE

```
Input: any non-empty message

Action:
  newState = 'TIMELINE'
  firstName = data.contactName?.split(' ')[0] || ''
  prefix = firstName ? "Got it, {firstName} 👍\n\n" : ""
  reply = "{prefix}When are you planning the surgery?"
  dataUpdates = { insurance: message.trim() }
  ingestionTrigger = 'update'
```

---

### STATE: TIMELINE

```
Input: any non-empty message

Note: This state is ALSO handled by Global Override Layer CHECK 1.X (timeline is
      NOT a global override). The TIMELINE state receives ANY input as the answer.
      Knowledge layer is blocked (TIMELINE not in knowledge-eligible states).
      So any input here goes directly to Layer 3 — TIMELINE handler.

Action:
  newState = 'COMPLETE'
  firstName = data.contactName?.split(' ')[0] || ''
  greeting = firstName ? "Perfect, {firstName}! 🎉" : "Perfect! 🎉"
  reply = "{greeting}\n\nOur LASIK specialist will contact you shortly.\n\n
           Meanwhile, I can help you with:\n• Cost\n• Recovery\n• Book consultation"
  dataUpdates = { timeline: message.trim() }
  ingestionTrigger = 'update'

Note: timeline captured as-is, not normalized.
      Scoring (HOT/WARM/COLD) happens in backend, not chatbot.
```

---

### STATE: ASK_RESUME

```
Triggered by: RESTART detection (Layer 1 CHECK 1.1) when session has partial data.

On entry (this IS the reply for ASK_RESUME):
  missing = []
  if !data.surgeryCity → missing.push('preferred surgery city')
  if !data.insurance → missing.push('insurance')
  if !data.timeline → missing.push('timeline')
  
  if missing.length === 0:
    newState = 'COMPLETE'
    reply = "Welcome back, {firstName}! 👋 All your details are saved ✅\n\nOur specialist will contact you shortly."
    ingestionTrigger = null
  else:
    newState = 'ASK_PERMISSION'
    data._resuming = true
    reply = "Welcome back, {firstName}! 👋\n\nWould you like to continue where we left off?\nStill needed: {missing.join(', ')}\n\nReply *Yes* to continue or *No* to just chat 😊"
    ingestionTrigger = null

Note: ASK_RESUME itself does not receive user input — it IS the response to a
      restart signal. The next message is processed in ASK_PERMISSION state.
```

---

### STATE: RETURNING

```
Triggered by: GREETING handler when GET /api/check-lead returns an existing lead.

Action:
  newState = 'COMPLETE'
  firstName = data.contactName?.split(' ')[0] || 'there'
  reply = "Welcome back, {firstName}! 👋\n\nWhat would you like to know?\n• Cost\n• Recovery\n• Talk to a doctor"
  dataUpdates = { is_returning: true }
  ingestionTrigger = null

Note: RETURNING is a transient state — it transitions to COMPLETE immediately.
      It exists only to generate the correct welcome-back reply.
```

---

### STATE: COMPLETE

```
COMPLETE is a terminal state.
Layer 3 (state machine) is not invoked for COMPLETE state.
Layer 2 (knowledge) IS active for COMPLETE state.
Global overrides (Layer 1) are always active.

Default behavior if COMPLETE receives a message and knowledge returns nothing:
  reply = "I can help you with:\n\n• LASIK cost\n• Recovery time\n• Eligibility\n\nOr I can arrange a specialist call for you."
  newState = UNCHANGED (COMPLETE)
  ingestionTrigger = null
```

---

## CLEAN INTENT LISTS (CORRECTED)

### Sales Intent (SPECIFIC PHRASES ONLY — no single common words)

```javascript
SALES_INTENT_PHRASES = [
  "call me", "call back", "call kar", "mujhe call",
  "talk to doctor", "talk to specialist", "baat karni hai",
  "doctor se baat", "specialist chahiye",
  "book appointment", "appointment chahiye", "appointment book",
  "book consultation", "consultation chahiye",
  "speak to advisor", "advisor se baat",
  "human help", "real person", "agent chahiye",
  "callback", "call back karo", "call back karein"
]
// Match: message_lower.includes(phrase) for any phrase in list
// Do NOT use single words: help, call, number, phone, contact, doctor, talk
```

### Knowledge Intents (UNCHANGED — these are keyword-based, correct as-is)

```
RECOVERY: recovery, recover, healing, kitne din, kitna time, kab tak,
          how much time, how long, time will it take, recover time, ...
PAIN: pain, painful, dard, dard hoga, takleef, hurt, ...
ELIGIBILITY: eligible, eligibility, suitable, possible, kar sakta, ...
REFERRAL: refer, referral, reward, earn, paisa, ...
COST: cost, price, charges, fees, kharcha, rate, expense, amount, ...
TIMELINE: when, how soon, timeline, schedule, kab, jaldi, ...
SAFETY: scared, fear, safe, risk, side effects, nervous, ...
```

### Eye Power Pattern (STRICT REGEX — replaces current overly broad version)

```
Pattern: /(?:(?:power|no\.?|number)\s*)?[+-]\d{1,2}(?:\.\d{1,2})?\b/i

Matches: "-3.5", "+2.0", "power -4", "no. -2.5", "-0.75"
Does NOT match: "3-4 months", "25 years", "₹45,000", "1.5 km", "3.5 stars"

Additional context requirement: the number should appear standalone or after
  power-related words, not in a price/time context.
Context exclusion: if message contains rupees/rs/₹ or "year" within 3 words
  of the number → do NOT trigger power detection.
```

---

## STATE TRANSITION TABLE (COMPLETE)

```
┌──────────────────┬──────────────────────────────────────────────────────┐
│  Current State   │  Transitions                                         │
├──────────────────┼──────────────────────────────────────────────────────┤
│  GREETING        │  any → ASK_PERMISSION                               │
├──────────────────┼──────────────────────────────────────────────────────┤
│  ASK_PERMISSION  │  yes/consent → NAME (or first_missing if _resuming)  │
│                  │  anything else → COMPLETE                            │
├──────────────────┼──────────────────────────────────────────────────────┤
│  NAME            │  valid name → CITY                                   │
│                  │  invalid (attempt 1) → NAME                          │
│                  │  invalid (attempt 2+) → CITY (accept any)            │
├──────────────────┼──────────────────────────────────────────────────────┤
│  CITY            │  any → SURGERY_CITY                                  │
├──────────────────┼──────────────────────────────────────────────────────┤
│  SURGERY_CITY    │  any → INSURANCE                                     │
├──────────────────┼──────────────────────────────────────────────────────┤
│  INSURANCE       │  any → TIMELINE                                      │
├──────────────────┼──────────────────────────────────────────────────────┤
│  TIMELINE        │  any → COMPLETE                                      │
├──────────────────┼──────────────────────────────────────────────────────┤
│  ASK_RESUME      │  (state set on entry) → ASK_PERMISSION               │
│                  │  or → COMPLETE (if no missing fields)                │
├──────────────────┼──────────────────────────────────────────────────────┤
│  RETURNING       │  (state set on entry) → COMPLETE                    │
├──────────────────┼──────────────────────────────────────────────────────┤
│  COMPLETE        │  (terminal — knowledge only, no state change)        │
│                  │  RESTART override → GREETING or ASK_RESUME           │
└──────────────────┴──────────────────────────────────────────────────────┘

Global overrides (Layer 1) NEVER change state, regardless of current state.
Knowledge layer (Layer 2) NEVER changes state, regardless of current state.
```

---

## WHAT WAS REMOVED OR CHANGED FROM V1

| V1 behavior | V2 change | Reason |
|-------------|-----------|--------|
| Knowledge layer sets `data.timeline` | Removed | Qualification field must only be set in state machine |
| `sendToAPI("initial")` on first message | Removed | Empty payload provides no value |
| SALES_INTENT matches single words (help, phone, contact, number) | Replaced with specific phrases only | Too many false positives |
| Power regex `/-?\d+(\.\d+)?/` | Replaced with context-aware pattern | Matched years, prices, durations incorrectly |
| `sendToAPI` awaited before reply | Changed to parallel | Was blocking reply path up to 40s |
| 5 retries × 40s timeout | Changed to 3 retries × 8s | Faster failure detection |
| Health ping inside sendToAPI | Removed | Wasteful, backend handles its own keep-alive |
| In-memory sessions | Changed to Supabase persistent store | Lost on every deploy |
| No per-phone lock | Added | Prevents concurrent message race condition |
| No message deduplication in chatbot | Added | Meta can deliver same message 2-3x |
| resuming flag via `_resuming` in data | Replaced with explicit ASK_PERMISSION sub-case routing | Cleaner, testable |
