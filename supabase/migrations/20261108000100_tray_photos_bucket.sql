-- Staged photos for recipes in the plan tray (docs/chatbot-design.md 7.1): <tray id>/<slug>.jpg in a PRIVATE bucket.
-- Only the server reads and writes them (service role); editors see them through short-lived signed URLs. There are deliberately NO
-- policies on storage.objects for this bucket, so anon and authenticated can't list, read or write anything in it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tray-photos', 'tray-photos', false, 8388608, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
