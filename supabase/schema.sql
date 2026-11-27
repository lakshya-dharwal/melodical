-- Melodical cloud backup schema. Run once in the Supabase SQL editor (safe to re-run).
-- Every row and every audio file belongs to the signed-in user; RLS keeps users apart.

create table if not exists public.projects (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb,                          -- the whole Project; null on tombstones
  updated_at  bigint not null,                -- ms since epoch, set by the client (newer wins)
  deleted     boolean not null default false
);
create index if not exists projects_user_updated on public.projects (user_id, updated_at);

create table if not exists public.takes (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id  text,
  meta        jsonb,                          -- the Take without its audio
  updated_at  bigint not null,
  deleted     boolean not null default false
);
create index if not exists takes_user_updated on public.takes (user_id, updated_at);
create index if not exists takes_user_project on public.takes (user_id, project_id);

alter table public.projects enable row level security;
alter table public.takes enable row level security;

drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own takes" on public.takes;
create policy "own takes" on public.takes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Private bucket for take audio: takes/<user_id>/<take_id>.flac
insert into storage.buckets (id, name, public)
values ('takes', 'takes', false)
on conflict (id) do update set public = false;

drop policy if exists "own take files: read" on storage.objects;
create policy "own take files: read" on storage.objects
  for select to authenticated
  using (bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own take files: insert" on storage.objects;
create policy "own take files: insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own take files: update" on storage.objects;
create policy "own take files: update" on storage.objects
  for update to authenticated
  using (bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own take files: delete" on storage.objects;
create policy "own take files: delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'takes' and (storage.foldername(name))[1] = auth.uid()::text);
