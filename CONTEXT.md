# Relive Cure System Context

## 1. PROJECT OVERVIEW
The Relive Cure system is an automated lead management pipeline designed to capture leads from WhatsApp messages and manage their lifecycle through to pushing them into a CRM (Refrens). The high-level goal is to eliminate manual data entry by automatically interpreting incoming messages, storing the parsed leads into a centralized database, and providing an admin dashboard to review, filter, and push qualified leads to the sales team's CRM.

## 2. ARCHITECTURE
The system operates on a pipeline architecture:
**WhatsApp** -> **Chatbot** -> **Backend** -> **Supabase** -> **Dashboard** -> **CRM**

- **WhatsApp**: The entry point where potential clients message the business.
- **Chatbot**: Receives the webhook from Meta, processes the message (often using NLP/AI), and determines if it constitutes a lead.
- **Backend**: Acts as the central nervous system. It receives lead ingestion requests from the Chatbot, saves them to the database, handles dashboard authentication, and coordinates the automation scripts.
- **Supabase**: The PostgreSQL database hosting the `leads_surgery` table to persistently store lead records.
- **Dashboard**: A React-based web interface used by admins to monitor the lead funnel, triage inquiries, and trigger CRM integrations.
- **CRM (Refrens)**: The final destination where leads are pushed using an automated Puppeteer script running on the Backend.

## 3. SERVICES (WITH LINKS)

**Chatbot**
- URL: `https://lasik-whatsapp-bot-production.up.railway.app/webhook`
- Repo: `jaskiring/lasik-whatsapp-bot`

**Backend**
- URL: `https://relive-cure-backend-production.up.railway.app`
- Repo: `jaskiring/relive-cure-backend`

**Dashboard**
- URL: `https://relive-cure-dashboard-production.up.railway.app`
- Repo: `jaskiring/relive-cure-dashboard`

**Supabase**
- URL: `https://mvtiktflaqdkukswaker.supabase.co`

## 4. DATA FLOW

1. **How message becomes lead**: A user sends a WhatsApp message. Meta sends a webhook payload to the Chatbot service. The Chatbot filters out status updates and duplicate messages, parses the user's intent, and decides whether to send a reply and ingest the lead.
2. **How lead is stored**: The Chatbot sends a POST request with the parsed data to the Backend's `/api/ingest-lead`. The Backend securely validates the request using a Bot Secret and inserts/updates the row in the `leads_surgery` table via the Supabase Service Role Key.
3. **How dashboard reads it**: The React Dashboard uses the Supabase anon key to connect directly to the database and fetch/subscribe to rows in `leads_surgery`.
4. **How CRM push works**: When an admin clicks "Push to CRM" on the Dashboard, it sends a request with the `x-crm-key` token to `/api/push-to-crm-form` on the Backend. The Backend launches Puppeteer, navigates to Refrens, handles auth via stored cookies, fills out the CRM form using the database record, and marks the lead as `pushed_to_crm=true`.

## 5. AUTH SYSTEM

- **Login Flow**: The admin visits the Dashboard and enters credentials. The Dashboard sends these to `/api/auth/login`.
- **Backend Auth Endpoint**: The backend checks the credentials against its `VITE_ADMIN_USERNAME` and `VITE_ADMIN_PASSWORD` environment variables. If valid, it returns `{ success: true, token: <CRM_API_KEY> }`.
- **Token Handling**: The Dashboard saves this token in `localStorage` as `crm_token` and marks `auth=true`.
- **Headers**: Subsequent protected API calls from the Dashboard (e.g., deleting a lead or pushing to CRM) include this token in the `x-crm-key` HTTP header.

## 6. ENVIRONMENT VARIABLES

### Frontend (VITE_*)
*These variables are bundled with the React app and are considered public configuration.*
- `VITE_SUPABASE_URL`: Public URL to the Supabase instance for data fetching.
- `VITE_SUPABASE_ANON_KEY`: Public anonymous key for Supabase allowing RLS-restricted access.
- `VITE_CRM_API_URL`: The URL of the Backend service to direct API calls.
- `VITE_ADMIN_USERNAME`: Default admin username for the login screen.
- `VITE_ADMIN_PASSWORD`: Default admin password for the login screen.

### Backend (Secure)
*These variables are kept strictly on the server and are NEVER exposed to the frontend repository to prevent leaks.*
- `SUPABASE_URL`: URL to the Supabase instance.
- `SUPABASE_SERVICE_ROLE_KEY`: Admin-level key allowing the backend to bypass RLS and execute database operations.
- `CRM_API_KEY`: Secret token required in headers to authorize CRM push actions from the dashboard.
- `REFRENS_EMAIL` / `REFRENS_PASSWORD` / `REFRENS_COOKIES`: Credentials and session data used by Puppeteer to authenticate with the CRM.
- `WHATSAPP_ACCESS_TOKEN` / `PHONE_NUMBER_ID`: Used to send replies back to users via the Meta Graph API.
- `BOT_SECRET`: Secret shared with the Chatbot to authenticate ingestion requests (`x-bot-key`).

## 7. API ENDPOINTS

- `/webhook`: (Chatbot) Meta webhook for receiving incoming WhatsApp messages and status updates.
- `/api/ingest-lead`: (Backend) Receives structured lead data from the Chatbot and inserts it into Supabase. Protected by `x-bot-key`.
- `/api/auth/login`: (Backend) Verifies admin credentials and issues the `CRM_API_KEY` as an access token.
- `/api/push-to-crm-form`: (Backend) Receives a list of leads from the Dashboard, executes the Puppeteer script to push them to Refrens, and updates their status. Protected by `x-crm-key`.
- `/health`: (Backend) Simple endpoint returning `200 OK` and node version info, used for uptime monitoring and keeping the service awake.

## 8. DATABASE STRUCTURE

**Table**: `leads_surgery`
- **Key Fields**: `id`, `phone_number`, `contact_name`, `created_at`, `status`, `intent_level`, `lead_stage`, `remarks`.
- **Intent Logic**: Tracks `interest_cost`, `interest_recovery`, `concern_pain`, `concern_safety`, and `urgency_level` as booleans/enums to classify the lead's core interest and assign them a "HOT/WARM/COLD" or "REFERRAL" intent.
- **`pushed_to_crm` Flag**: A boolean used to prevent double-pushing leads. Once successfully added to Refrens, this is set to `true`.

## 9. CRM AUTOMATION

- **Puppeteer Flow**: The backend launches a headless Chrome instance. It navigates to the Refrens dashboard.
- **Data Mapping**: It maps fields like `contact_name`, `phone_number`, and derived text (like timeline info) from the `leads` object into the corresponding DOM inputs on the Refrens form.
- **Test vs Real Logic**: To avoid spamming the CRM during development, test leads (e.g. ones created manually or specific designated numbers) might be blocked or processed differently, though production relies on the `pushed_to_crm` check to gate execution.

## 10. SECURITY MODEL

- **Secrets are backend-only**: The previous architecture leaked the `SUPABASE_SERVICE_ROLE_KEY` in the frontend bundle. This was fixed by keeping all admin keys on Railway and removing them from frontend code.
- **VITE is public**: Any variable prefixed with `VITE_` is baked into the public `bundle.js`. Therefore, only safe, non-sensitive config variables are placed there.
- **What caused the leak**: The service role key was mistakenly placed in a frontend `.env` file, causing Vite to include it in the build output, which was then committed to Git history.
- **How it was fixed**: The Git history was scrubbed using `git filter-repo`. The frontend login flow was redesigned to dynamically request the `CRM_API_KEY` token at runtime instead of hardcoding it. `.gitignore` was updated across repositories to permanently ban `.env` and `bundle.js`.

## 11. DEPLOYMENT

- **Railway Setup**: All three services (Chatbot, Backend, Dashboard) are connected to GitHub via Railway.
- **Build Flow**: Commits to `main` trigger automatic builds. Railway handles the containerization (Node.js/Vite builds).
- **Environment Injection**: Variables are managed in the Railway dashboard and injected into the Node.js process (`process.env`) or the Vite build process (`import.meta.env`) during deployment.

## 12. TESTING FLOW

- **cURL Tests**: Use `curl` to ping `/health` or send mock data to `/api/auth/login` to ensure basic HTTP routing and env var presence.
- **UI Tests**: Logging into the Dashboard to check lead rendering and ensuring the "Push to CRM" button functions.
- **Webhook Tests**: Simulating Meta payloads using `curl` or Postman targeting `/webhook` to confirm message deduplication and chatbot handoff.

## 13. KNOWN EDGE CASES

- **Timeline Parsing Issues**: Ambiguous or complex timeline texts might not map perfectly into rigid CRM drop-downs, requiring manual intervention in the UI.
- **Cold Start Behavior**: Railway spins down inactive environments. The first webhook or API call after a quiet period may take 5-10 seconds while the container boots, which can cause timeout warnings if not handled properly.
- **Rate Limits**: Meta Graph API strict rate limits apply. Sending too many WhatsApp messages rapidly results in 429 errors.

## 14. FUTURE IMPROVEMENTS

- **Better Auth**: Upgrade from the simple static token (`CRM_API_KEY`) to robust session management (e.g., JWTs with expirations) or integrate Supabase Auth.
- **Queue for CRM Push**: Implement a robust background job queue (like BullMQ) to handle Puppeteer timeouts gracefully and ensure no leads are dropped if the CRM is slow.
- **Retry Handling**: Automate retries for Meta Graph API calls and Refrens form submissions in case of transient network errors.
