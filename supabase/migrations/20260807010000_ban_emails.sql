-- Banning an email address, as distinct from deleting an account.
--
-- Deleting frees the address for immediate re-registration, which is the wrong
-- answer for abuse. A ban keeps the person out under that address:
--
--   login  - auth.users.banned_until is enforced by GoTrue itself
--   signup - a BEFORE INSERT trigger on auth.users rejects the address
--
-- Both live below the API, so neither can be bypassed by calling Supabase
-- directly with the anon key.

create table if not exists public.banned_emails (
  -- Stored lowercased; the trigger and RPCs normalise before comparing, since
  -- citext is not installed on this project.
  email text primary key,
  reason text,
  banned_at timestamptz not null default now(),
  banned_by uuid references auth.users(id) on delete set null
);

alter table public.banned_emails enable row level security;

-- Reachable only through the admin RPCs below. A publicly readable denylist
-- would leak who has been banned.
drop policy if exists admin_manage_banned_emails on public.banned_emails;
create policy admin_manage_banned_emails on public.banned_emails
  for all using ((select public.is_admin())) with check ((select public.is_admin()));

revoke all on public.banned_emails from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signup enforcement.
-- ---------------------------------------------------------------------------
create or replace function public.reject_banned_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.banned_emails where email = lower(btrim(NEW.email))) then
    raise exception 'This email address is not permitted to register.' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists reject_banned_signup on auth.users;
create trigger reject_banned_signup
  before insert on auth.users
  for each row execute function public.reject_banned_signup();

revoke all on function public.reject_banned_signup() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ban / unban.
-- ---------------------------------------------------------------------------
create or replace function public.ban_user_admin(
  p_user_id uuid,
  p_reason text default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row public.profiles;
  target_email text;
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot ban the account you are signed in with.' using errcode = '42501';
  end if;

  select * into before_row from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  select lower(btrim(email)) into target_email from auth.users where id = p_user_id;
  if target_email is null or target_email = '' then
    raise exception 'That account has no email address to ban.' using errcode = '22023';
  end if;

  insert into public.banned_emails (email, reason, banned_by)
  values (target_email, nullif(btrim(coalesce(p_reason, '')), ''), (select auth.uid()))
  on conflict (email) do update
    set reason = excluded.reason, banned_at = now(), banned_by = excluded.banned_by;

  -- Far future rather than 'infinity': GoTrue compares against now() and some
  -- clients choke on an infinite timestamp.
  update auth.users set banned_until = now() + interval '100 years' where id = p_user_id;
  -- Existing sessions would otherwise keep working until they expire.
  delete from auth.sessions where user_id = p_user_id;

  update public.profiles
  set account_status = 'suspended'::public.account_status,
      suspension_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Banned by an administrator'),
      suspended_at = now()
  where id = p_user_id;

  insert into public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) values (
    (select auth.uid()), 'user.ban', 'profile', p_user_id, p_request_id, to_jsonb(before_row),
    jsonb_build_object('email', target_email, 'reason', p_reason)
  );

  return jsonb_build_object('banned', true, 'email', target_email);
end;
$$;

create or replace function public.unban_email_admin(
  p_email text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := lower(btrim(coalesce(p_email, '')));
  restored uuid;
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  if normalized = '' then
    raise exception 'An email address is required.' using errcode = '22023';
  end if;

  delete from public.banned_emails where email = normalized;

  select id into restored from auth.users where lower(btrim(email)) = normalized;
  if restored is not null then
    update auth.users set banned_until = null where id = restored;
    update public.profiles
    set account_status = 'active'::public.account_status, suspension_reason = null, suspended_at = null
    where id = restored;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, request_id, details)
  values ((select auth.uid()), 'user.unban', 'profile', restored, p_request_id,
          jsonb_build_object('email', normalized));

  return jsonb_build_object('unbanned', true, 'email', normalized, 'accountRestored', restored is not null);
end;
$$;

create or replace function public.list_banned_emails_admin()
returns table(email text, reason text, banned_at timestamptz, has_account boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  return query
  select b.email, b.reason, b.banned_at,
         exists (select 1 from auth.users u where lower(btrim(u.email)) = b.email)
  from public.banned_emails b
  order by b.banned_at desc;
end;
$$;

revoke all on function public.ban_user_admin(uuid, text, text) from public, anon;
revoke all on function public.unban_email_admin(text, text) from public, anon;
revoke all on function public.list_banned_emails_admin() from public, anon;
grant execute on function public.ban_user_admin(uuid, text, text) to authenticated;
grant execute on function public.unban_email_admin(text, text) to authenticated;
grant execute on function public.list_banned_emails_admin() to authenticated;
