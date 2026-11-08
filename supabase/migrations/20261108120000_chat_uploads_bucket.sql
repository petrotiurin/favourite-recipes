-- Photos an editor attaches in the chat (docs/chatbot-design.md D3 images, 7.1): <conversation id>/<uuid>.jpg in a PRIVATE bucket.
-- The server re-encodes every upload (sharp, JPEG) before storing it; only the server reads and writes them (service role). The
-- panel shows them through short-lived signed URLs. There are deliberately NO policies on storage.objects for this bucket, so anon
-- and authenticated can't list, read or write anything in it. Objects of deleted or expired chats are swept by the server
-- (lib/chat-uploads.js sweepOrphans), because deleting rows from storage.objects in SQL would leave the files behind.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-uploads', 'chat-uploads', false, 4194304, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
