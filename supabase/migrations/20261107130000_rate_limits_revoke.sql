-- Lock the rate-limit counters down like the chat tables: RLS is already on with no policies, and this also revokes the
-- table-level grants from the browser roles, so nothing depends on RLS alone. Only the service role (the server) touches them.
revoke all on public.rate_limits from anon, authenticated;
grant all on public.rate_limits to service_role;
