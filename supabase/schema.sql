-- ============================================================
-- Zina database. Paste this whole file into Supabase → SQL Editor → Run.
-- ============================================================

-- Every piece of shared data (questions, tests, words, posts, leaderboard) lives in one table.
create table if not exists public.docs (
  path        text primary key,             -- e.g. questions/q_abc123
  collection  text not null,                -- e.g. questions
  doc_id      text not null,
  data        jsonb not null default '{}'::jsonb,
  owner       uuid default auth.uid(),
  updated_at  timestamptz not null default now()
);
create index if not exists docs_collection_idx on public.docs (collection, updated_at desc);

create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text,
  plan        text not null default 'free' check (plan in ('free','pro','elite')),
  paid_until  timestamptz,
  trial_until timestamptz,
  trial_used  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- ---------- helpers ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid())
$$;

-- new account → profile row with their name
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- partial update of a document (runs with the caller's permissions)
create or replace function public.merge_doc(p_path text, p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  update docs set data = data || p_patch, updated_at = now() where path = p_path
$$;

-- like / unlike a community post (anyone signed in, only touches their own like)
create or replace function public.toggle_like(p_path text) returns void
language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text;
begin
  if me is null or p_path not like 'posts/%' then raise exception 'not allowed'; end if;
  update docs set
    data = case when coalesce(data->'likes', '{}'::jsonb) ? me
                then jsonb_set(data, '{likes}', (data->'likes') - me)
                else jsonb_set(data, '{likes}', coalesce(data->'likes', '{}'::jsonb) || jsonb_build_object(me, true)) end,
    updated_at = now()
  where path = p_path;
end $$;

-- one free 3-day Pro trial per account
create or replace function public.start_trial() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update profiles set trial_until = now() + interval '3 days', trial_used = true
  where id = auth.uid() and not trial_used;
  return found;
end $$;

-- server-side AI limit (called only by /api/ai with the service key)
create or replace function public.bump_ai(p_user uuid, p_limit int) returns boolean
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  if p_limit <= 0 then return false; end if;
  insert into ai_usage (user_id, day, count) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set count = ai_usage.count + 1
    where ai_usage.count < p_limit
  returning count into c;
  return c is not null;
end $$;
revoke execute on function public.bump_ai(uuid, int) from public, anon, authenticated;

-- ---------- security ----------
alter table public.docs     enable row level security;
alter table public.admins   enable row level security;
alter table public.profiles enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated
  using (
    (collection not in ('drafts','payments','entitlements') and collection not like 'data/users/%')
    or is_admin()
    or collection = 'data/users/' || auth.uid()::text
    or (collection = 'entitlements' and doc_id = auth.uid()::text)
    or (collection = 'payments' and data->>'uid' = auth.uid()::text)
  );

-- each student's own progress (score, goal, answers, schedule) — follows them to any device
drop policy if exists own_state on public.docs;
create policy own_state on public.docs for all to authenticated
  using (collection = 'data/users/' || auth.uid()::text)
  with check (collection = 'data/users/' || auth.uid()::text);

-- students submit a card-transfer receipt; only the owner can approve (entitlements are admin-only)
drop policy if exists payments_insert on public.docs;
create policy payments_insert on public.docs for insert to authenticated
  with check (collection = 'payments' and data->>'uid' = auth.uid()::text and data->>'status' = 'pending');

drop policy if exists docs_admin on public.docs;
create policy docs_admin on public.docs for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists posts_insert on public.docs;
create policy posts_insert on public.docs for insert to authenticated
  with check (collection = 'posts' and data->>'uid' = auth.uid()::text);

drop policy if exists posts_update_own on public.docs;
create policy posts_update_own on public.docs for update to authenticated
  using (collection = 'posts' and owner = auth.uid())
  with check (collection = 'posts' and data->>'uid' = auth.uid()::text);

drop policy if exists posts_delete_own on public.docs;
create policy posts_delete_own on public.docs for delete to authenticated
  using (collection = 'posts' and owner = auth.uid());

drop policy if exists players_insert on public.docs;
create policy players_insert on public.docs for insert to authenticated
  with check (collection = 'players' and doc_id = auth.uid()::text);

drop policy if exists players_update on public.docs;
create policy players_update on public.docs for update to authenticated
  using (collection = 'players' and doc_id = auth.uid()::text)
  with check (collection = 'players' and doc_id = auth.uid()::text);

drop policy if exists admins_read_self on public.admins;
create policy admins_read_self on public.admins for select to authenticated using (user_id = auth.uid());

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);

drop policy if exists ai_usage_read_self on public.ai_usage;
create policy ai_usage_read_self on public.ai_usage for select to authenticated using (user_id = auth.uid());

-- ---------- realtime ----------
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
