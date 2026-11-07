-- Rate-limit counters for the chat endpoint (docs/chatbot-design.md section 8).
-- One row per (key, window): the key is a salted hash of the visitor's IP (never the raw IP), the window a fixed
-- hour or day. Only the server touches this, with the service-role key: RLS is on and there are deliberately NO
-- policies for the anon and authenticated roles, so the browser can't read or write it with the public key.

create table if not exists public.rate_limits (
  key          text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (key, window_start)
);

create index if not exists rate_limits_window_start_idx on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;

-- Atomically counts one hit in the current fixed window of p_window_seconds and returns the new count.
-- The caller compares it with its limit. Old windows are swept now and then.
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  integer;
begin
  if p_window_seconds < 1 then
    raise exception 'p_window_seconds must be positive';
  end if;

  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '2 days';
  end if;

  return v_count;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer) to service_role;
