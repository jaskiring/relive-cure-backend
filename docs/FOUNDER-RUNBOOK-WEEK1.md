# Founder runbook — after Cursor ships Week 1 foundation

> **Cost:** ₹0 new infra. Keep Railway ₹500 + existing subs.

## 1 · Supabase (15 min, once)

Open Supabase SQL editor → run **in order**:

1. `server/migrations/create_wa_lines.sql`
2. `server/migrations/create_organic_leads.sql`
3. `server/migrations/create_agent_jobs.sql`
4. `server/migrations/grant_organic_wa_lines_service_role.sql`

Verify: `select * from wa_lines;` → should show `bot` row.

Then on Railway backend → add env var: **`WA_LINES_ENABLED=true`** (only after migrations).

## 2 · Deploy code (10 min)

Push backend + dashboard to Railway (or ask Cursor to deploy).

Env vars already set: `CRM_API_KEY`, `GEMINI_API_KEY`, WhatsApp Cloud tokens.

**Do NOT set `WA_LINES_ENABLED=true` until step 1 migrations are done.** Bot uses the legacy capture path until then — production-safe.

## 3 · Rep WhatsApp lines (per rep, ~5 min each)

1. CRM → **Settings** → scroll to **WhatsApp lines**
2. Click **Add rep line** → enter rep name
3. On M4 Mac, in terminal:

```bash
cd ~/Documents/relive-cure-workspace/relive-cure-backend/server/scripts/wa-bridge
npm install
export CRM_API_KEY="your-crm-key-from-settings"
export BACKEND_URL="https://relive-cure-backend-production.up.railway.app"
node wa-bridge.mjs --line=rep_rahul   # use id shown in CRM
```

4. QR appears in **terminal** AND in CRM Settings
5. Rep opens WhatsApp → ⋮ → Linked devices → Link a device → scan QR
6. Status → **connected**. Leave terminal running (or use `tmux` / `screen`)

**Repeat per rep line.** M4 must stay awake + online while reps work.

## 4 · Organic screenshots (nightly, 2 min setup)

```bash
mkdir -p ~/ReliveCure/social-inbox/processed ~/ReliveCure/logs
```

During day: screenshot IG/FB comment notifications → save to `~/ReliveCure/social-inbox/`

Manual run:

```bash
cd ~/Documents/relive-cure-workspace/relive-cure-backend
export GEMINI_API_KEY="..."
export CRM_API_KEY="..."
node server/scripts/parse-social-screenshots.mjs
```

Cron (2am):

```bash
crontab -e
# add:
0 2 * * * cd /Users/jaskiring/Documents/relive-cure-workspace/relive-cure-backend && GEMINI_API_KEY=xxx CRM_API_KEY=xxx node server/scripts/parse-social-screenshots.mjs >> ~/ReliveCure/logs/social-parse.log 2>&1
```

Morning: CRM → **Marketing** → **Organic** tab → review queue → **Copy DM template** → paste in IG/FB manually (v0).

## 5 · Update DM template link

Edit `OrganicMarketingTab.jsx` WA link to your real bot number, OR set in CRM later.

## 6 · Daily ops checklist

| Task | Where |
|------|-------|
| Check bridge connected | Settings → WhatsApp lines |
| Reply organic queue | Marketing → Organic |
| Multi-line inbox | WhatsApp Chat → line filter dropdown |
| Lead story | Any lead → Lore tab → Flow view |
| Re-engage list | Marketing → Organic (Deal Done 6mo+) |

## 7 · If bridge disconnects

1. Re-run `node wa-bridge.mjs --line=...`
2. Rep re-scans QR if logged out
3. Session saved in `server/scripts/wa-bridge/sessions/<line_id>/` — usually reconnects without QR

## 8 · Risks you accepted

- WA Web = unofficial. Occasional disconnect. Don't use for bot number (keep Cloud API).
- Screenshot parsing = manual capture step until Meta webhook.
- M4 must run bridge during rep WA hours.

## 9 · Next upgrades (not built yet)

- Auto-DM on IG (Meta app review)
- Send from CRM on rep lines (bridge outbound API)
- Trend scout weekly brief
- Rep app in-app QR scan
