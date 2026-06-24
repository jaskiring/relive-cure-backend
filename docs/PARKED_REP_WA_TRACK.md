# PARKED — Rep WhatsApp + call-recording track

**Status:** PARKED (founder decision). Code is committed and wired behind kill-switches; **do not enable in prod** until migrations + founder sign-off.

## What this track includes

| Area | Files | Flag |
|------|-------|------|
| Multi-line WA bridge | `organic-wa-routes.js`, `wa-bridge/`, `whatsapp-store.js` rep path | `WA_LINES_ENABLED=true` (after `create_wa_lines.sql`) |
| Rep device fleet | `rep-devices-routes.js`, `RepApplicationTab.jsx`, rep-app | `REP_FLEET_ENABLED=true` (after `create_rep_devices.sql`) |
| Call recordings | `google-drive.js`, `call-row-helpers.js`, `transcribe-calls.mjs`, Lore call events | M4 scripts only; not Railway |
| Organic marketing UI | `OrganicMarketingTab.jsx`, `WaLinesPanel.jsx` | Not imported in `App.jsx` until unparked |
| Migrations | `create_wa_lines.sql`, `create_organic_leads.sql`, `create_rep_devices.sql`, `alter_call_recordings_call_log.sql`, grants | Founder runs in Supabase |

## Default behavior (safe)

- `WA_LINES_ENABLED` unset → bot uses legacy Cloud API path only; `/api/wa-bridge/ingest` returns 503.
- `REP_FLEET_ENABLED` unset → rep-device routes not registered (404).
- Dashboard parked tabs exist in repo but are **not** in the nav until imported.

## To unpark later

1. Run migrations in order (see `docs/ACTIVATION.md` §Parked track).
2. Set flags on Railway backend.
3. Import tabs in `App.jsx` + RBAC.
4. Smoke-test rep-app heartbeat + wa-bridge on M4.
