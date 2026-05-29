# Checkpoint — 2026-05-23 (Phase F shipped, before Phase G)

## Where we are

All four P0 issues from earlier today are **fixed, deployed, and live-verified** on Railway. The CRM push pipeline that was burning ad spend with zero hand-off is now end-to-end working: Meta lead → dashboard → Refrens CRM with correct fields AND auto-assigned to the right teammate.

## What shipped today (Phase F)

| Phase | Commit | What it does | Verified |
|---|---|---|---|
| F1 | `2b58c5b` | Replaced false-positive `bodyHas.required` body-text grep with inline-validation-only check. The old code matched the literal word "Required" rendered in every field's helper text on every page load → bogus "required field missing" errors masking the real failure. | Diagnostic now reports the real cause (empty fields, network, etc) |
| F2 | `c7a6e86` | Stage dropdown picked by LABEL not positional index 3. Refrens reordered the form; old hardcoded index could land on the wrong dropdown silently. | `[CRM] Stage dropdown found at index N` log |
| F3 | `c7a6e86` | Prospect-org last-resort clears the input fully (was still filtered to "relive") before picking the first available. Logs a loud warning so you know if the fallback fired. | — |
| F4 | `5a393ef` / `f7253b1` | `setReactInputValue` — minimal native-setter + single `input` event. Refrens phone-input rejects the React-fiber-onChange double-fire variant. Verified the simple version works for name/city; phone needs the +91 prefix. | Lead 9999900500 written end-to-end |
| F5 | `57e3805` (FE) | `SENDING_ENABLED = !!windowOpen` — composer unlocks inside the 24h Meta window, locks outside (templates still allowed). Banner copy reduced to two states (open / closed). | Bundle has new strings; user needs hard-refresh to clear cached JS |
| F6 | `ed1b43e` | `BOT_MSG.LOCATION` no longer leaks clinic address/hours; pivots to consultation question. | Backend diff |
| F7 | `ed1b43e` | NAME state detects high-intent words ("lasik", "surgery", etc) and replies "I see you want to explore LASIK 👁️ — can I catch your name first?" instead of robotic "Sorry, what should I call you?". Captures `session.data.stated_intent`. | User confirmed in transcript |
| **CRM-PUSH-CORE** | `5b1d617` | **Submit click uses DOM `.click()` via `page.evaluate`, NOT `page.click(SEL)`.** Root cause: in headless Puppeteer, `page.mouse.click(x,y)` doesn't fire React's onClick handler. Same for the Prospect-Org option — must call `element[__reactProps].onClick({...})` directly. | First successful prod push: lead `9999900500` |
| F8 | `438145e` | Post-create Lead Assignee step. After lead is created, opens detail page → clicks "Lead assignee" pencil → types name in `searchCollaborator` input → walks radios to find one whose ancestor row contains the name → clicks "Save Changes" → clicks **"Yes, Transfer Lead"** confirmation dialog. The second dialog was easy to miss. | Lead 9999900600 with `assignee: "nishikant"` ended up assigned to NISHIKANT not Relive Cure |
| F9 (BE) | `62f0140` | `isValidName` rejects Hinglish/English question words (`kya, kaise, kab, kahan, kyu, kyon, what, how, ...`), any `?`, Devanagari question particles, and any reply with ≥3 words. `passiveExtract` city: permissive capture when `lastAskedField === 'CITY'` — accepts any 1-2 word letter reply ≤30 chars that isn't a generic filler. Fixes "kya hota he ye proccess" being stored as name "kya" and Bharatpur being re-asked forever. | Backend diff |
| F9 (FE) | `b9bd4ea` | Inbound chat bubble color uses `var(--text-main)` + `var(--bar-track)`. Dark-theme override sets bubble bg to `rgba(255,255,255,0.08)`. Fixes empty-bubbles bug in dark mode. | Bundle diff |
| FE confirm-count fix | `bd03c5c` | "About to push N leads" now uses `filteredLeads.filter(l => !l.pushed_to_crm).length` instead of `filteredLeads.length`. Matches the button label. | — |

## What's NOT shipped yet — Phase G (mobile + push)

Gated explicitly behind F passing; ready to start on demand.

- **G1** — PWA manifest + service worker (`public/manifest.webmanifest`, `vite-plugin-pwa`, Add to Home Screen on iOS Safari + Android Chrome).
- **G2** — Mobile responsive sweep: sidebar → bottom-tabs <768px, tables → stacked cards, full-screen sheets for modals + lead detail.
- **G3** — Web Push for new leads: `push_subscriptions` Supabase table, `/api/push/subscribe`, fanout from `leads_surgery` realtime insert using `web-push` lib. iOS 16.4+ supports this on PWAs.
- **G4** — Notification deep-link: SW handles `notificationclick` → opens `/lead/<id>?focus=1` → dashboard routes into lead detail panel.
- **G5** — Founder smoke test: add to iPhone home screen, allow notifications, send a test WhatsApp lead, notification arrives within ~3s, tap → lands on lead detail.

## Key files modified this turn

- `server/crm-automation.js` — biggest changes; the entire Puppeteer flow rewritten for React-Select. New helpers: `setReactInputValue`, `assignLeadToCollaborator`.
- `server/index.js` — `BOT_MSG.LOCATION`, `isValidName`, `passiveExtract` (city block), NAME-state handler.
- `relive-cure-dashboard/src/App.jsx` — `SENDING_ENABLED`, banner copy, Send button label, push confirmation count, inbound bubble inline color.
- `relive-cure-dashboard/src/index.css` — `.v3-inbox-bubble.inbound` to use CSS vars + dark-theme override.

## Critical knowledge for the next session

These were hard-won — don't lose them.

1. **In headless Puppeteer, `page.mouse.click(x,y)` does NOT trigger React's `onClick`.** Use either `page.evaluate(() => el.click())` (DOM click event) or call `element[__reactProps].onClick({target, currentTarget, ...})` directly. React-Select v3 options only have `onClick`, no `onMouseDown`.

2. **Refrens prospect search needs 4+ characters.** `rel` → "No Prospect Found"; `reli` / `relive` → "Relive cure".

3. **Refrens phone input requires E.164 format with `+91` prefix.** Raw `9999900099` resets to `+91` only. Set `+919999900099` → displays as `+91 99999-00099` and submits cleanly.

4. **There are TWO modals in the assignee flow.** "Change Lead Assignee" → "Save Changes" → opens a second "Transfer Lead — Are you sure?" → "Yes, Transfer Lead" → only then persists.

5. **Refrens new-lead form has no Assignee field.** Assignee is set on the lead detail page post-creation.

6. **CRM_API_KEY** is `relive_crm_secure_key_2026`. **Backend URL**: `https://relive-cure-backend-production.up.railway.app`. **Frontend URL**: `https://relive-cure-dashboard-production.up.railway.app`.

## Resume command

> "Pick up from CHECKPOINT.md — start Phase G (PWA + push notifications). G1 first: install vite-plugin-pwa, add manifest.webmanifest, register SW, test 'Add to Home Screen' on iOS Safari + Android Chrome."
