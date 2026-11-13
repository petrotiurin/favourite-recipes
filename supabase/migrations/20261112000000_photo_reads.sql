-- Reading recipe photos in the chat (docs/parallel-photo-reading.md): a lightweight queue in Postgres, one row per photo, plus the
-- pieces of the chat it needs: an `event` message role (a note from the site, e.g. "photos read"), `handled_at` on messages (exactly one
-- turn hands an event to the model) and a per-conversation turn lock. Like the other chat tables, only the server touches these, with
-- the service-role key: RLS is on with no policies and every grant to anon / authenticated is revoked.

-- One row per photo an editor attached in a conversation.
--   n            the photo's number in the conversation, in picked order across messages (photo-7): what the panel's badges show
--   path         the photo in the private bucket chat-uploads (<conversation id>/<uuid>.jpg)
--   status       queued | reading | read | failed | skipped
--   result       what the first pass read off this photo (the recipe plus the grouping signals)
--   group_id     "3+4": the photos read together as one recipe (set by grouping); recipe: the second pass's read of that group (first member)
--   joined_to    the user said this photo carries on photo n (a correction); split_from_prev: the user said it does NOT carry on the one before
--   tray_item_id the tray card staged from it
create table if not exists public.photo_reads (
  id                  uuid        primary key default gen_random_uuid(),
  conversation_id     uuid        not null references public.conversations (id) on delete cascade,
  user_id             uuid        not null,
  name                text,
  n                   integer     not null,
  path                text        not null,
  status              text        not null default 'queued' check (status in ('queued', 'reading', 'read', 'failed', 'skipped')),
  attempts            integer     not null default 0,
  lease_until         timestamptz,
  result              jsonb,
  group_id            text,
  recipe              jsonb,
  joined_to           integer,
  split_from_prev     boolean     not null default false,
  tray_item_id        text,
  error               text,
  created_at          timestamptz not null default now(),
  read_at             timestamptz,
  report_lease_until  timestamptz,
  reported_at         timestamptz,
  unique (conversation_id, path),
  unique (conversation_id, n)
);

create index if not exists photo_reads_active_idx on public.photo_reads (status) where status in ('queued', 'reading');
create index if not exists photo_reads_conversation_idx on public.photo_reads (conversation_id, n);

alter table public.photo_reads enable row level security;
revoke all on public.photo_reads from anon, authenticated;
grant all on public.photo_reads to service_role;

-- Claims up to p_max queued photos of one conversation (lowest n first) for reading, never letting more than p_cap be reading at once
-- across the household. Leases that ran out (an instance died) first go back on the queue, or fail after p_max_attempts.
create or replace function public.claim_photo_reads(p_conversation uuid, p_max integer, p_cap integer, p_lease_ms integer, p_max_attempts integer default 2)
returns setof public.photo_reads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free integer;
begin
  perform pg_advisory_xact_lock(hashtext('photo_reads_claim'));
  update public.photo_reads
     set status = case when attempts >= p_max_attempts then 'failed' else 'queued' end,
         error = case when attempts >= p_max_attempts then 'The read was cut off twice' else error end,
         lease_until = null
   where status = 'reading' and lease_until < now();
  select greatest(0, p_cap - count(*)) into v_free from public.photo_reads where status = 'reading';
  if v_free <= 0 then
    return;
  end if;
  return query
    update public.photo_reads p
       set status = 'reading', attempts = p.attempts + 1, lease_until = now() + make_interval(secs => p_lease_ms / 1000.0)
     where p.id in (
       select id from public.photo_reads
        where conversation_id = p_conversation and status = 'queued'
        order by n
        limit least(p_max, v_free)
        for update skip locked)
    returning p.*;
end;
$$;

-- Claims the report of a conversation whose queue is idle (nothing queued or reading): every read or failed photo not yet reported,
-- with a lease, so exactly one drainer reports. Returns nothing while photos are still being read or another report holds the lease.
create or replace function public.claim_photo_report(p_conversation uuid, p_lease_ms integer)
returns setof public.photo_reads
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('photo_report:' || p_conversation::text));
  if exists (select 1 from public.photo_reads where conversation_id = p_conversation and status in ('queued', 'reading')) then
    return;
  end if;
  if exists (select 1 from public.photo_reads where conversation_id = p_conversation and reported_at is null and report_lease_until > now()) then
    return;
  end if;
  return query
    update public.photo_reads
       set report_lease_until = now() + make_interval(secs => p_lease_ms / 1000.0)
     where conversation_id = p_conversation and status in ('read', 'failed') and reported_at is null
    returning *;
end;
$$;

-- Messages: an `event` role (a note from the site, shown in the panel as a status line and handed to the model as a user-role note) and
-- handled_at (set, atomically, by whichever turn hands the event to the model first).
alter table public.messages drop constraint if exists messages_role_check;
alter table public.messages add constraint messages_role_check check (role in ('user', 'assistant', 'tool', 'event'));
alter table public.messages add column if not exists handled_at timestamptz;

-- Conversations: a turn lock (taken by every turn, user or follow-up; expires by itself after the turn budget) and the time of the newest
-- reply, for the bubble's unread dot on the next page load.
alter table public.conversations add column if not exists turn_lock_until timestamptz;
alter table public.conversations add column if not exists turn_lock_id text;
alter table public.conversations add column if not exists last_reply_at timestamptz;

create or replace function public.take_turn_lock(p_conversation uuid, p_token text, p_ms integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.conversations
     set turn_lock_until = now() + make_interval(secs => p_ms / 1000.0), turn_lock_id = p_token
   where id = p_conversation and (turn_lock_until is null or turn_lock_until < now())
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.claim_photo_reads(uuid, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_photo_report(uuid, integer) from public, anon, authenticated;
revoke all on function public.take_turn_lock(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_photo_reads(uuid, integer, integer, integer, integer) to service_role;
grant execute on function public.claim_photo_report(uuid, integer) to service_role;
grant execute on function public.take_turn_lock(uuid, text, integer) to service_role;
