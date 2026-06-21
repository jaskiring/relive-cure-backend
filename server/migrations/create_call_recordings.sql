-- call_recordings — one row per cellular call made/received on a rep's phone.
-- Populated by the rep Android app's POST /api/calls/upload-complete after it
-- pairs the OEM call recording with the call-log entry and uploads the audio
-- to the rep's Google Drive. Transcript + extraction are filled in later by the
-- overnight pipeline. Surfaced in Lore (via a lead_events 'call' row), Pulse,
-- and the call-validation view.
--
-- Run once in the Supabase SQL editor.

create table if not exists call_recordings (
  id               uuid primary key default gen_random_uuid(),
  rep_id           text,                       -- rep identifier from the app session
  rep_name         text,
  phone            text not null,              -- normalised lead phone (last 10 digits)
  direction        text,                       -- 'inbound' | 'outbound'
  call_started_at  timestamptz,
  duration_sec     int default 0,
  connected        boolean,                    -- answered (duration above threshold)
  outcome          text,                       -- post-call tag: HOT / OPD booked / Will follow up / Not interested / DNP
  followup_needed  boolean default false,
  drive_file_id    text,                       -- Google Drive file ID of the .m4a recording
  drive_file_url   text,
  matched_lead_id  text,                       -- linked CRM/chatbot lead (by phone)
  matched_source   text,                       -- 'refrens' | 'chatbot'
  transcript       text,
  transcript_status text default 'pending',    -- pending | done | failed | no_recording
  extracted        jsonb,                      -- AI extraction (summary, objections, next step)
  device_meta      jsonb,                      -- phone model, OEM, app version
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_call_recordings_phone on call_recordings (phone, call_started_at desc);
create index if not exists idx_call_recordings_rep   on call_recordings (rep_id, call_started_at desc);
create index if not exists idx_call_recordings_tstat on call_recordings (transcript_status);
create unique index if not exists idx_call_recordings_drive_file_id on call_recordings (drive_file_id) where drive_file_id is not null;

GRANT ALL ON TABLE public.call_recordings TO service_role;
GRANT SELECT ON TABLE public.call_recordings TO anon, authenticated;
