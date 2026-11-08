-- The household plan tray (docs/chatbot-design.md D5, 7.1): what the editors' chat has staged but not saved to the site yet.
-- ONE tray for the whole household: a unique index on a constant allows at most one row. Only the server touches it, with the
-- service-role key: RLS is on and there are deliberately NO policies for anon and authenticated (their grants are revoked too).
--
--   status      collecting | finalising | ready   (collecting: being built; finalising: the agent is building the shopping list;
--                                                  ready: the list is current, or none is needed, so Save is available)
--   items       jsonb array. Each item: { id, kind, op (a batch_changes operation), added_by { email, name }, reason, created_at,
--               error, photo { status, path, ... }, base (the recipe as it was when staged, for clash detection), clash }
--   list_hash   hash of the other items at the moment the shopping list was staged: if the items change, the list is out of date
--   version     bumped on every write; the server only writes if it is still the version it read (two editors never overwrite each other)
--   expires_at  first item + 7 days. An expired tray is deleted (with its staged photos) the next time the server touches it.
create table if not exists public.trays (
  id          uuid        primary key default gen_random_uuid(),
  status      text        not null default 'collecting' check (status in ('collecting', 'finalising', 'ready')),
  items       jsonb       not null default '[]'::jsonb,
  list_hash   text,
  version     integer     not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- At most one tray, ever (the household's). Saving or expiring deletes the row; the next item starts a new 7-day tray.
create unique index if not exists trays_one_per_household on public.trays ((true));

alter table public.trays enable row level security;

revoke all on public.trays from anon, authenticated;
grant all on public.trays to service_role;
