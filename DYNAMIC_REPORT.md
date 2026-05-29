# RELIVE CURE v2 - SYSTEM DYNAMIC AUDIT REPORT

## ═══════════════════════════════════════════════════
## TASK 1: STATIC VALUES IN DASHBOARD THAT MUST BE DYNAMIC
## ═══════════════════════════════════════════════════

The following hardcoded values were found in `relive-cure-dashboard/src/App.jsx` and should be refactored:

1.  **Lead Statuses Array:**
    *   **Value:** `const STATUSES = ['new', 'contacted', 'follow_up', 'ipd_done', 'lost', 'pushed_to_crm'];`
    *   **Issue:** Hardcoded. Adding a new status requires a code deployment.
    *   **Fix:** Should be pulled from a configuration table in Supabase or derived dynamically from ENUMs in the DB.
2.  **Sales Reps Array:**
    *   **Value:** `const REPS = ['Anjali', 'Deepak', 'Siddharth', 'Priyanka', 'Rahul'];`
    *   **Issue:** Hardcoded names.
    *   **Fix:** Should be queried from a `users` or `reps` table in the database.
3.  **Cities Array:**
    *   **Value:** `const CITIES = ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Ahmedabad', 'Chennai', 'Pune'];`
    *   **Issue:** Hardcoded. If the bot expands to new cities, the dashboard won't filter them natively.
    *   **Fix:** Should be populated dynamically by `SELECT DISTINCT city FROM leads_surgery`.
4.  **Backend CRM API URL Fallback:**
    *   **Value:** `import.meta.env.VITE_CRM_API_URL || 'https://relive-cure-backend-production.up.railway.app'`
    *   **Issue:** Prod URL is hardcoded as a fallback. This can cause local dev instances to accidentally hit the production database if the env var is missing.
    *   **Fix:** Enforce `VITE_CRM_API_URL` strictly without a production fallback.
5.  **Overdue SLA Threshold:**
    *   **Value:** `const isOverdue = l.status !== 'pushed_to_crm' && l.status !== 'lost' && hoursSinceActivity > 4;`
    *   **Issue:** The `4` hour limit is hardcoded. 
    *   **Fix:** Should pull from a global configuration context or environment variable (e.g., `VITE_OVERDUE_SLA_HOURS`).
6.  **Chart Colors & Intent Labels:**
    *   **Value:** Hardcoded hex dictionaries and string matching (`label.includes('HOT')`).
    *   **Issue:** Changing "HOT" to "HIGH INTENT" breaks the entire dashboard counting logic.

## ═══════════════════════════════════════════════════
## TASK 2: CUSTOMER DATA MAPPING (BOT -> DB)
## ═══════════════════════════════════════════════════

Based on `server/index.js` and `backend/src/lib/ingestion.js`:

| Field | Meaning | How it's set | Type | In Dashboard? | Should Show? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `phone_number` | WhatsApp number | Passive extraction | String | YES | YES |
| `contact_name` | Name of user | Bot state / WhatsApp Profile | String | YES | YES |
| `city` | User's current city | Passive / Bot state | String | YES | YES |
| `timeline` | Expected surgery timeline | Passive / Intent | String | YES | YES |
| `insurance` | Has insurance? | Passive / Intent | String | YES | YES |
| `interest_cost` | Asked about pricing | Intent detection | Bool | NO | YES |
| `interest_recovery` | Asked about recovery time | Intent detection | Bool | NO | YES |
| `concern_pain` | Afraid of pain | Intent detection | Bool | NO | YES |
| `concern_safety` | Afraid of risks | Intent detection | Bool | NO | YES |
| `concern_power` | Asked about eligibility/power | Intent detection | Bool | NO | YES |
| `intent_level` | Hot/Warm/Cold | Computed backend | String | YES | YES |
| `intent_score` | Numeric lead strength | Computed backend | Int | YES | YES |
| `urgency_level` | High/Medium/Low | Computed from timeline | String | YES | YES |
| `request_call` | User wants to talk | Intent/Escalation | Bool | YES | YES |
| `callback_source` | Why callback triggered | Bot Engine | String | NO | YES |
| `language` | Interaction Language | Auto-detected | String | NO | YES |
| `bot_version` | Engine handling chat | Hardcoded Engine | String | NO | OPTIONAL |
| `current_flow_state`| Where user stopped | Bot Engine | String | NO | YES |
| `message_count` | Total engagement depth | Counter in Session | Int | NO | YES |
| `first_message_at` | True start of conversation| Session metadata | Date | NO | YES |
| `last_message_at` | Last interaction | Session metadata | Date | NO | YES |
| `user_questions` | Compiled raw data notes | Bot payload builder | String | YES | YES |
| `pushed_to_crm` | Sync status | Backend sync job | Bool | YES | YES |

> [!WARNING]
> `callback_source` is completely missing from the Supabase Upsert payload in `backend/src/lib/ingestion.js`, so it is lost completely before it even reaches the DB.

## ═══════════════════════════════════════════════════
## TASK 3: IDEAL LEAD DRAWER CONFIGURATION
## ═══════════════════════════════════════════════════

**A. Identity**
*   `name`: YES (Text)
*   `phone`: YES (Clickable link)
*   `city`: YES (Text)
*   `language`: NO -> **Should be:** Badge (e.g. `[HI]` or `[EN]`)

**B. Medical**
*   `eye power`: NO -> **Should be:** Extracted from `user_questions` into a dedicated UI Badge.
*   `power stability`: NO -> **Should be:** Extracted from `user_questions` into Text.
*   `insurance`: YES -> **Should be:** Status Icon (Green check / Red X).

**C. Intent Signals (Currently entirely hidden)**
*   `cost`, `recovery`, `pain`, `safety`, `power`: NO -> **Should be:** A row of boolean tag pills (e.g., `💰 Pricing Concerned`, `⚡ Fear of Pain`) highlighting exactly what to pitch them on.

**D. Sales Status**
*   `intent_score`: YES -> **Should be:** Progress Bar (`value/100`), but backend needs a score cap of 100 first.
*   `urgency`: YES -> **Should be:** Color-coded Badge.
*   `request_call`: YES -> **Should be:** Flashing Icon or highlighted banner.
*   `callback_source`: NO -> **Should be:** Text explanation (e.g., "Requested via Escalation").

**E. Timeline & Bot State**
*   `created_at`: YES -> **Should be:** Date text.
*   `message_count`: NO -> **Should be:** Number badge (shows how deep the conversation went).
*   `current_flow_state`: NO -> **Should be:** Pipeline badge (e.g., `Stopped at: ASK_CITY`).
*   `user_questions`: YES -> **Should be:** Dedicated "Raw Bot Notes" card.

## ═══════════════════════════════════════════════════
## TASK 4: STATS CARDS VALIDATION
## ═══════════════════════════════════════════════════

**1. 🔥 HOT LEADS**
*   **Query:** `enrichedLeads.filter(l => l._intent.label.includes('HOT')).length`
*   **Is it accurate?** Yes, relying on string matching of the mapped intent levels.

**2. 📞 CALL REQ**
*   **Query:** `enrichedLeads.filter(l => l.request_call).length`
*   **Is it accurate?** Yes, maps directly to the boolean field.

**3. ⏰ PENDING FOLLOW-UPS**
*   **Query:** `enrichedLeads.filter(l => !l.pushed_to_crm).length`
*   **Is it accurate?** **NO.** This logic simply counts *everything* not pushed to the CRM (including new, unqualified, or cold leads). The secondary card correctly uses `l.status === 'follow_up' || l.status === 'contacted'`, causing a severe mismatch between the primary counter and the filtered view.

**4. 📋 TOTAL LEADS**
*   **Query:** `enrichedLeads.length`
*   **Is it accurate?** Yes, though it includes 'Lost' leads which might inflate the active pipeline metric.

**Overdue — Move or Lose (Secondary Card)**
*   **Query:** `l.status !== 'pushed_to_crm' && l.status !== 'lost' && hoursSinceActivity > 4`
*   **Is it accurate?** If it equals the Total Leads, it means *all* leads in the system are currently older than 4 hours and haven't been pushed to CRM or marked lost. The logic is technically sound, but the SLA (4h) is strictly hardcoded.

## ═══════════════════════════════════════════════════
## TASK 5: FIX REPORT & ACTION PLAN
## ═══════════════════════════════════════════════════

### STATIC_VALUES_TO_MAKE_DYNAMIC
```javascript
// App.jsx (Dashboard) - Fix SLA Threshold
// FROM:
const isOverdue = l.status !== 'pushed_to_crm' && l.status !== 'lost' && hoursSinceActivity > 4;
// TO:
const SLA_HOURS = parseInt(import.meta.env.VITE_OVERDUE_SLA_HOURS || '4', 10);
const isOverdue = l.status !== 'pushed_to_crm' && l.status !== 'lost' && hoursSinceActivity > SLA_HOURS;

// App.jsx (Dashboard) - Fix Cities Array
// FROM:
const CITIES = ['Mumbai', 'Delhi', ...];
// TO:
// Extract unique cities from data payload dynamically
const dynamicCities = useMemo(() => {
  return [...new Set(leads.map(l => l.city).filter(Boolean))].sort();
}, [leads]);
```

### MISSING_FROM_DRAWER (Backend payload fix required first)
```javascript
// src/lib/ingestion.js (Backend Repo) - Fix payload mapping
// ADD THIS to the payload object on line 83:
callback_source: leadData.callback_source || '',
```

### WRONG_METRIC_LOGIC
```javascript
// App.jsx (Dashboard) - Fix Primary Card Logic Mismatch
// FROM:
pending: enrichedLeads.filter(l => !l.pushed_to_crm).length
// TO:
pending: enrichedLeads.filter(l => l.status === 'follow_up' || l.status === 'contacted').length
```

### NEW_METRICS_TO_ADD
```javascript
// App.jsx (Dashboard) - Intent Signal Badges inside Drawer
// Add this render block inside the Lead Drawer component
<div className="intent-signals">
  {selectedLead.interest_cost && <span className="badge badge-blue">💰 Cost Intent</span>}
  {selectedLead.interest_recovery && <span className="badge badge-green">⚡ Fast Recovery</span>}
  {selectedLead.concern_pain && <span className="badge badge-orange">😨 Pain Concern</span>}
  {selectedLead.concern_safety && <span className="badge badge-red">🛡️ Safety Concern</span>}
</div>
```
