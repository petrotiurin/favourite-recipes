-- Editors' chats (docs/chatbot-design.md section 5, decisions D4 and Q8): server-owned history.
-- Only the server touches these tables, with the service-role key: RLS is on and there are deliberately NO policies for
-- the anon and authenticated roles, so the browser can't read or write them with the public key (every grant is revoked
-- too, as a second lock). A conversation belongs to one Supabase user (user_id = auth.users.id, which never changes,
-- unlike an email); the server only ever loads a conversation whose user_id is the verified caller's.

create table if not exists public.conversations (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived    boolean     not null default false
);

create index if not exists conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index if not exists conversations_updated_idx on public.conversations (updated_at);

-- One row per message the model sees: the OpenAI-format message object in `content` (user text; an assistant message with
-- its tool_calls; a tool result), plus a `ui` key on an assistant message for what the panel shows again on reload (recipe
-- cards, navigation button, suggested replies). `seq` gives a stable order within a conversation.
-- turn_id groups the rows of one user turn (one /chat request = one Langfuse trace, trace_id); feedback is the editor's
-- thumbs up/down on that turn, kept on the turn's last assistant row: { value: 1 | 0, reasons: [], note: "" }.
create table if not exists public.messages (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null references public.conversations (id) on delete cascade,
  seq              bigint      generated always as identity,
  role             text        not null check (role in ('user', 'assistant', 'tool')),
  content          jsonb       not null,
  turn_id          text,
  trace_id         text,
  feedback         jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_seq_idx on public.messages (conversation_id, seq);
create index if not exists messages_turn_idx on public.messages (conversation_id, turn_id);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

revoke all on public.conversations from anon, authenticated;
revoke all on public.messages from anon, authenticated;
grant all on public.conversations to service_role;
grant all on public.messages to service_role;

-- Retention (Q8): a chat is deleted 2 weeks after its last message, messages and all (they cascade).
-- The server calls this opportunistically when an editor opens their chats list (lib/chat-store.js), so it works on any
-- plan; pg_cron, where available, also runs it daily (below). Keep the 14 days in step with RETENTION_DAYS in lib/chat-store.js.
create or replace function public.purge_old_chats()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.conversations where updated_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_old_chats() from public, anon, authenticated;
grant execute on function public.purge_old_chats() to service_role;

-- Optional: a daily sweep with pg_cron, if the extension is available and this role may create it. Never fails the migration.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('purge-old-chats', '17 3 * * *', 'select public.purge_old_chats()');
  end if;
exception when others then
  raise notice 'pg_cron not set up (%): the server purges old chats when the chats list is opened instead', sqlerrm;
end;
$$;
