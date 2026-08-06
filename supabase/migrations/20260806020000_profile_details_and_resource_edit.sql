-- Profile self-service, a leaderboard that excludes staff, and owner edits
-- that go back through moderation.

-- ---------------------------------------------------------------------------
-- New profile fields.
--
-- profiles uses column-level grants rather than table-level ones, so a new
-- column is invisible and unwritable until it is granted explicitly. Adding the
-- column alone would leave the profile form silently unable to read it back.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists date_of_birth date,
  add column if not exists avatar_key text;

comment on column public.profiles.avatar_key is
  'R2 object key for the profile photo. Served through the portal, not linked directly.';

-- avatar_key is readable by anyone so a photo can render next to a name.
-- date_of_birth is personal, so only the signed-in owner can read it, and RLS
-- restricts that to their own row.
grant select (avatar_key) on public.profiles to anon, authenticated;
grant select (date_of_birth) on public.profiles to authenticated;
grant update (date_of_birth, avatar_key) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Leaderboard without staff accounts.
--
-- authenticated cannot select profiles.role, which is deliberate - who holds
-- admin should not be public. So the filter cannot live in the API query; it
-- has to happen somewhere that can read the column without exposing it.
-- ---------------------------------------------------------------------------
create or replace function public.list_leaderboard(
  page_number integer default 1,
  page_size integer default 20
)
returns table(
  id uuid, full_name text, avatar text, avatar_key text, points integer,
  level integer, uploads integer, downloads integer, badge text,
  verified boolean, university_name text, total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 20), 3), 50);
begin
  return query
  with ranked as (
    select
      profile.id, profile.full_name, profile.avatar, profile.avatar_key,
      profile.points, profile.level, profile.uploads, profile.downloads,
      profile.badge, profile.verified,
      university.name as university_name,
      count(*) over() as result_total
    from public.profiles as profile
    left join public.universities as university on university.id = profile.university_id
    where profile.role <> 'admin'::public.user_role
      and profile.account_status = 'active'::public.account_status
  )
  select
    ranked.id, ranked.full_name, ranked.avatar, ranked.avatar_key, ranked.points,
    ranked.level, ranked.uploads, ranked.downloads, ranked.badge, ranked.verified,
    ranked.university_name, ranked.result_total
  from ranked
  order by ranked.points desc, ranked.id
  offset (safe_page - 1) * safe_size
  limit safe_size;
end;
$$;

revoke all on function public.list_leaderboard(integer, integer) from public;
grant execute on function public.list_leaderboard(integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Profile updates.
--
-- A null argument means "leave this alone" rather than "clear it", so a form
-- that submits one field cannot blank the rest.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_profile(
  p_full_name text default null,
  p_date_of_birth date default null,
  p_country text default null,
  p_institution_type public.institution_type default null,
  p_university_id uuid default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  after_row public.profiles;
begin
  if caller is null then
    raise exception 'Sign in to update your profile.' using errcode = '42501';
  end if;
  if p_full_name is not null and char_length(btrim(p_full_name)) not between 2 and 80 then
    raise exception 'Enter a name between 2 and 80 characters.' using errcode = '22023';
  end if;
  -- A date in the future, or one implying an age over 120, is a typo.
  if p_date_of_birth is not null
     and (p_date_of_birth > current_date or p_date_of_birth < current_date - interval '120 years') then
    raise exception 'Enter a valid date of birth.' using errcode = '22023';
  end if;

  update public.profiles
  set full_name = coalesce(nullif(btrim(coalesce(p_full_name, '')), ''), full_name),
      date_of_birth = coalesce(p_date_of_birth, date_of_birth),
      country = coalesce(nullif(btrim(coalesce(p_country, '')), ''), country),
      institution_type = coalesce(p_institution_type, institution_type),
      university_id = coalesce(p_university_id, university_id)
  where id = caller
  returning * into after_row;

  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
  return after_row;
end;
$$;

revoke all on function public.update_my_profile(text, date, text, public.institution_type, uuid) from public, anon;
grant execute on function public.update_my_profile(text, date, text, public.institution_type, uuid) to authenticated;

-- Points the profile at a stored photo, returning the key it replaced so the
-- caller can delete the old object instead of orphaning it.
create or replace function public.set_my_avatar(p_avatar_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  previous_key text;
begin
  if caller is null then
    raise exception 'Sign in to update your photo.' using errcode = '42501';
  end if;

  select avatar_key into previous_key from public.profiles where id = caller for update;
  update public.profiles
  set avatar_key = nullif(btrim(coalesce(p_avatar_key, '')), '')
  where id = caller;

  return previous_key;
end;
$$;

revoke all on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Owner edits to an uploaded document.
--
-- An approved document that changes has not been reviewed in its new form, so
-- it returns to pending. Anything else would let approved content be swapped
-- for unreviewed content after the fact.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_resource(
  p_resource_id uuid,
  p_title text,
  p_description text default null,
  p_course_id uuid default null,
  p_category_id uuid default null,
  p_department text default null,
  p_semester text default null
)
returns public.resources
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  before_row public.resources;
  after_row public.resources;
begin
  if caller is null then
    raise exception 'Sign in to edit your uploads.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 3 and 200 then
    raise exception 'Enter a title between 3 and 200 characters.' using errcode = '22023';
  end if;

  select * into before_row from public.resources where id = p_resource_id for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if before_row.uploader_id is distinct from caller then
    raise exception 'You can only edit your own uploads.' using errcode = '42501';
  end if;
  if before_row.status = 'removed'::public.resource_status then
    raise exception 'This document was removed by a moderator and cannot be edited.' using errcode = '42501';
  end if;

  update public.resources
  set title = btrim(p_title),
      description = nullif(btrim(coalesce(p_description, '')), ''),
      course_id = p_course_id,
      category_id = p_category_id,
      department = nullif(btrim(coalesce(p_department, '')), ''),
      semester = nullif(btrim(coalesce(p_semester, '')), ''),
      status = 'pending'::public.resource_status,
      moderated_at = null,
      moderated_by = null,
      moderation_reason = null,
      featured = false
  where id = p_resource_id
  returning * into after_row;

  return after_row;
end;
$$;

revoke all on function public.update_my_resource(uuid, text, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.update_my_resource(uuid, text, text, uuid, uuid, text, text) to authenticated;
