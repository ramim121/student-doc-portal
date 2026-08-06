-- University branding: an uploaded logo, and an editable monogram colour.
--
-- Institutions previously rendered as a gradient tile built from `short` and
-- `color`. Nothing in the admin console could change either, and there was
-- nowhere to put a real logo.
--
-- logo_key holds the R2 object key rather than a URL: the bucket is private, so
-- the portal serves the image through its own route. Storing a URL would have
-- meant either a public bucket or an expiring link baked into the row.

alter table public.universities
  add column if not exists logo_key text,
  add column if not exists logo_updated_at timestamptz;

comment on column public.universities.logo_key is
  'R2 object key for the institution logo. Served via the portal, not linked directly.';

-- universities already grants table-level SELECT to anon, so the new columns
-- are readable without a column grant. Writes stay with the admin RPCs below.

-- ---------------------------------------------------------------------------
-- Monogram colour is part of updating an institution, so it belongs on the
-- existing update RPC. Postgres cannot add a parameter via CREATE OR REPLACE.
-- ---------------------------------------------------------------------------
drop function if exists public.update_university_admin(uuid, text, text, public.record_status);

create or replace function public.update_university_admin(
  university_id uuid,
  new_name text,
  new_short text,
  new_status public.record_status,
  new_color text default null
)
returns public.universities
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row public.universities;
  after_row public.universities;
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(new_name, ''))) < 2 then
    raise exception 'A university name is required.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(new_short, ''))) < 1 then
    raise exception 'A short code is required.' using errcode = '22023';
  end if;

  select * into before_row from public.universities where id = university_id for update;
  if not found then
    raise exception 'University not found.' using errcode = 'P0002';
  end if;

  update public.universities
  set name = btrim(new_name),
      short = upper(btrim(new_short)),
      status = new_status,
      -- null leaves the existing colour alone, so a caller that does not send
      -- one cannot blank it by omission.
      color = coalesce(nullif(btrim(coalesce(new_color, '')), ''), before_row.color)
  where id = university_id
  returning * into after_row;

  insert into public.admin_audit_log (
    actor_id, action, target_type, target_id, before_data, after_data
  ) values (
    (select auth.uid()), 'university.update', 'university', university_id,
    to_jsonb(before_row), to_jsonb(after_row)
  );

  return after_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Logo pointer. The object itself is written to R2 by the admin route; this
-- records where it landed, and returns the key it replaced so the caller can
-- delete the old object instead of leaving it orphaned in the bucket.
-- ---------------------------------------------------------------------------
create or replace function public.set_university_logo_admin(
  p_university_id uuid,
  p_logo_key text,
  p_request_id text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row public.universities;
  previous_key text;
  normalized_key text;
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  select * into before_row from public.universities where id = p_university_id for update;
  if not found then
    raise exception 'University not found.' using errcode = 'P0002';
  end if;
  previous_key := before_row.logo_key;
  normalized_key := nullif(btrim(coalesce(p_logo_key, '')), '');

  update public.universities
  set logo_key = normalized_key,
      logo_updated_at = case when normalized_key is null then null else now() end
  where id = p_university_id;

  insert into public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) values (
    (select auth.uid()),
    case when normalized_key is null then 'university.logo.remove' else 'university.logo.set' end,
    'university', p_university_id, p_request_id, to_jsonb(before_row),
    jsonb_build_object('logoKey', normalized_key, 'previousLogoKey', previous_key)
  );

  return previous_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- The institution list has to know whether a logo exists, otherwise every card
-- would request one and fall back on a 404. Only the flag is exposed, never the
-- object key.
-- ---------------------------------------------------------------------------
drop function if exists public.list_universities_v2(text, integer, integer);

create or replace function public.list_universities_v2(
  query_text text default ''::text,
  page_number integer default 1,
  page_size integer default 24
)
returns table(
  id uuid, name text, short text, country text, color text,
  departments_count integer, resource_count bigint, contributor_count bigint,
  has_logo boolean, total_count bigint
)
language plpgsql
stable
set search_path to ''
as $$
declare
  normalized_query text := public.normalize_catalog_name(coalesce(query_text, ''));
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 24), 1), 48);
begin
  return query
  with matched as (
    select
      university.id,
      university.name,
      university.short,
      university.country,
      university.color,
      university.departments_count,
      (select count(*) from public.resources as resource where resource.university_id = university.id) as resource_count,
      (select count(*) from public.profiles as profile where profile.university_id = university.id) as contributor_count,
      (university.logo_key is not null) as has_logo
    from public.universities as university
    where normalized_query = ''
       or university.normalized_name like '%' || normalized_query || '%'
       or lower(university.short) like '%' || normalized_query || '%'
       or lower(university.country) like '%' || normalized_query || '%'
  ),
  counted as (
    select matched.*, count(*) over() as result_total
    from matched
  )
  select
    counted.id, counted.name, counted.short, counted.country, counted.color,
    counted.departments_count, counted.resource_count, counted.contributor_count,
    counted.has_logo, counted.result_total
  from counted
  order by counted.name, counted.id
  offset (safe_page - 1) * safe_size
  limit safe_size;
end;
$$;

grant execute on function public.list_universities_v2(text, integer, integer) to anon, authenticated;

revoke all on function public.update_university_admin(uuid, text, text, public.record_status, text) from public, anon;
revoke all on function public.set_university_logo_admin(uuid, text, text) from public, anon;
grant execute on function public.update_university_admin(uuid, text, text, public.record_status, text) to authenticated;
grant execute on function public.set_university_logo_admin(uuid, text, text) to authenticated;
