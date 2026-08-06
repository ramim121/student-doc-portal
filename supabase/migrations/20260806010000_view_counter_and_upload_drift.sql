-- Two counter defects found while checking the engagement features.
--
-- 1. resources.views was displayed on every card and on the resource page but
--    nothing ever incremented it. There was no RPC and no call site, so the
--    number every visitor saw was whatever the row was created with.
--
-- 2. profiles.uploads and profiles.points were raised by an AFTER INSERT
--    trigger with no delete counterpart. Deleting a resource left the uploader
--    credited for it forever, which is visible on the public leaderboard.

-- ---------------------------------------------------------------------------
-- View counter
-- ---------------------------------------------------------------------------
create or replace function public.increment_resource_view(resource_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Approved rows only: a pending or removed document is not publicly visible,
  -- so a view on one would be a counter someone forced rather than a real read.
  update public.resources
  set views = coalesce(views, 0) + 1
  where id = resource_id
    and status = 'approved'::public.resource_status;
end;
$$;

revoke all on function public.increment_resource_view(uuid) from public;
-- Anonymous visitors read resources, so they have to be able to count as views.
grant execute on function public.increment_resource_view(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Upload/points drift on delete
-- ---------------------------------------------------------------------------
create or replace function public.handle_resource_delete_counters()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if OLD.uploader_id is not null then
    update public.profiles
    -- greatest(...) so a counter that is already wrong cannot go negative.
    set uploads = greatest(coalesce(uploads, 0) - 1, 0),
        points = greatest(coalesce(points, 0) - 50, 0)
    where id = OLD.uploader_id;
  end if;
  return OLD;
end;
$$;

drop trigger if exists resource_delete_counters on public.resources;
create trigger resource_delete_counters
  after delete on public.resources
  for each row execute function public.handle_resource_delete_counters();

revoke all on function public.handle_resource_delete_counters() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Repair the drift the missing trigger already caused.
-- handle_resource_insert_counters is the only thing that awards points, at 50
-- per upload, so the correct total is derivable rather than guessed.
-- ---------------------------------------------------------------------------
update public.profiles as profile
set uploads = actual.count,
    points = actual.count * 50
from (
  select
    profile_row.id as profile_id,
    (select count(*) from public.resources as resource where resource.uploader_id = profile_row.id) as count
  from public.profiles as profile_row
) as actual
where profile.id = actual.profile_id
  and profile.uploads <> actual.count;
