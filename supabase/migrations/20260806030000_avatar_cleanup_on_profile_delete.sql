-- Deleting an account cascades the profiles row but leaves the profile photo in
-- the bucket, unreachable and billed forever. Resources already book a
-- storage_cleanup_job when they go; avatars now do the same, so the existing
-- Operations retry flow drains them.

create or replace function public.handle_profile_avatar_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if OLD.avatar_key is not null then
    insert into public.storage_cleanup_jobs (
      storage_provider, storage_key, reason, resource_id, delete_resource_on_success
    ) values (
      'r2', OLD.avatar_key, 'profile_avatar_deleted', null, false
    );
  end if;
  return OLD;
end;
$$;

drop trigger if exists profiles_cleanup_avatar on public.profiles;
create trigger profiles_cleanup_avatar
  after delete on public.profiles
  for each row execute function public.handle_profile_avatar_cleanup();

revoke all on function public.handle_profile_avatar_cleanup() from public, anon, authenticated;
