# FULL SYSTEM TECHNICAL AUDIT REPORT

## Dashboard Issues

1. **Recharts Container Warnings**: The `ResponsiveContainer` components wrapping the BarChart and PieChart generate console warnings with a `-1` width/height. This occurs because the parent flex containers do not have strict initial dimensions, causing measurement failures during initial rendering.
2. **Funnel Data Zeroing**: The `VisualFunnel` component heavily relies on strict `status` strings (`new`, `contacted`, `pushed_to_crm`). Since leads ingested by the backend do not explicitly set a default `new` status upon creation (it's often left `null` initially), the "New Leads" funnel step will artificially report `0`. Similarly, the "Contacted" step relies on manual updates to `contacted` or `follow_up`.
3. **Stats Discrepancy**: The "PENDING FOLLOW-UPS" metric simply filters by `!pushed_to_crm`. However, the "Overdue Move or Lose" metric applies a stricter 4-hour SLA check. This causes a misalignment in numbers that might confuse admins.
4. **Intent Score UI/Logic Mismatch**: The dashboard UI renders the intent score as `{selectedLead.intent_score || '0'}/100`. However, the backend saves this score as an integer that can mathematically exceed 100.

## Dashboard Files (`relive-cure-dashboard/src/`)

- **`App.jsx`**
  - **Purpose**: A monolithic component handling all dashboard views, state management, auth, Supabase real-time subscriptions, and chart rendering.
  - **Issues**: Monolithic architecture makes it hard to maintain. Funnel statuses rely on string matching that fails if DB is null.
  - **Hardcoded Values**: The backend URL `https://relive-cure-backend-production.up.railway.app` is hardcoded as a fallback for `VITE_CRM_API_URL`. The static lists `STATUSES` and `REPS` are hardcoded.

- **`lib/ingestion.js`**
  - **Purpose**: Appears to be a legacy copy of the backend's lead calculation logic.
  - **Issues**: Calculates `intent_score = parameters_completed;` (yielding 0-4 instead of a percentage). This file is entirely redundant since the backend is now strictly handling all webhooks and ingestion natively. Should be deleted.

- **`lib/supabase.js`**
  - **Purpose**: Initializes the Supabase client.
  - **Issues**: Hardcodes an anonymous JWT key in the source code as a fallback. While the comment states this prevents env var leakage, it is bad practice if RLS policies are not strictly locking down the tables.

## Backend Files (`relive-cure-backend/`)

- **`server/index.js`**
  - **Purpose**: The core Express server processing webhooks, embedding the `v6.2-stable` chatbot engine, and serving dashboard API routes.
  - **Endpoints Exposed**:
    - `GET /health`: Returns `{ status: "ok", bot: "v6.2-stable" }`.
    - `POST /api/auth/login`: Admin authentication.
    - `GET /webhook`: Meta API handshake.
    - `POST /webhook`: WhatsApp incoming message handler.
    - `POST /chat`: REST-based testing endpoint for bot interaction.
    - `DELETE /api/leads/:id`: Removes a lead.
    - `POST /api/push-to-crm-form`: Triggers Puppeteer pipeline.
  - **Issues**: Tightly coupled monolithic design merging chatbot business logic with HTTP routing.
  - **Hardcoded Values**: `"v6.2-stable"` in the health check.

- **`server/crm-automation.js`**
  - **Purpose**: Headless browser automation utilizing Puppeteer and `p-queue` to inject leads into the external Refrens CRM.
  - **Endpoints**: None.
  - **Issues**: Silent failure risks if Refrens alters DOM elements or forms. Relies on session cookie management which can expire unexpectedly.

- **`server/supabase-admin.js`**
  - **Purpose**: Initializes a Supabase admin client bypassing RLS using the `SUPABASE_SERVICE_ROLE_KEY`.
  - **Endpoints**: None.
  - **Issues**: No critical issues.

- **`src/lib/ingestion.js`**
  - **Purpose**: Mapped data transformation from raw bot state to Supabase `leads_surgery` rows.
  - **Issues**: `intent_score` calculation dynamically adds bonuses (e.g., +50 for HOT, +20 for High Urgency, +20 for Call Request). A perfect score mathematically hits `130/100`, breaking the dashboard UI's maximum range.
  - **Hardcoded Values**: Default `lead_type = 'surgery'`. Default `language = 'EN'`.

- **`package.json`**
  - **Purpose**: Node.js dependencies and scripts. Includes Express, Puppeteer, Supabase, and Vite scripts.
  - **Issues**: Contains mixed frontend (`vite`, `react`) and backend dependencies.

## Missing DB Fields

From the requested v6.2-stable telemetry audit against `src/lib/ingestion.js`:
- `user_questions`: ✅ Saved.
- `bot_version`: ✅ Saved.
- `first_message_at`: ✅ Saved.
- `last_message_at`: ✅ Saved.
- `message_count`: ✅ Saved.
- `current_flow_state`: ✅ Saved.
- `concern_power`: ✅ Saved.
- **`callback_source`**: ❌ **MISSING**. It is completely omitted from the `payload` object sent to `supabaseClient.upsert()`.

## Priority Fixes

- **[P0] Backend Ingestion Bug**: Add `callback_source` to the `payload` object in `src/lib/ingestion.js` to prevent permanent data loss of UTM/Source tracking.
- **[P0] Backend Scoring Bug**: Cap the `intent_score` to a maximum of 100 in `src/lib/ingestion.js` (`const intent_score = Math.min(score, 100);`).
- **[P1] Dashboard Funnel Logic**: Update `App.jsx` funnel calculations to correctly encompass `null` or uninitialized lead statuses.
- **[P2] Tech Debt**: Delete the redundant `lib/ingestion.js` located in the `relive-cure-dashboard` repo, and utilize strictly `.env` variables for the backend API URL.
