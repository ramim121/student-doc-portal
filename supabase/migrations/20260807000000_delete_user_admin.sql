-- Really deleting an account, rather than flagging it.
--
-- admin_set_account_status('deleted') only sets a flag. The row survives, the
-- email stays occupied, and the person still appears in listings - and because
-- the console applies it behind a single confirm, it is easy to hit by mistake.
-- (It was: the project owner's own account was flagged this way and every
-- upload then failed with ACCOUNT_RESTRICTED.)
--
-- These run as SECURITY DEFINER so the admin console never needs a service-role
-- key. Deleting from auth.users cascades profiles, resource_bookmarks,
-- study_notes and sessions.

-- ---------------------------------------------------------------------------
-- What would be destroyed. Read-only, so the console can show it before asking.
-- ---------------------------------------------------------------------------
create or replace function public.preflight_user_delete(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.profiles;
  target_email text;
  uploads integer;
  saves integer;
  notes integer;
  audit_entries integer;
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  select * into target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  select email into target_email from auth.users where id = p_user_id;

  select count(*) into uploads from public.resources where uploader_id = p_user_id;
  select count(*) into saves from public.resource_bookmarks where user_id = p_user_id;
  select count(*) into notes from public.study_notes where user_id = p_user_id;
  -- admin_audit_log.actor_id is ON DELETE NO ACTION on purpose: an audit trail
  -- that can be erased by deleting its author is not an audit trail.
  select count(*) into audit_entries from public.admin_audit_log where actor_id = p_user_id;

  return jsonb_build_object(
    'id', p_user_id,
    'email', coalesce(target_email, ''),
    'fullName', coalesce(target.full_name, ''),
    'role', target.role,
    'accountStatus', target.account_status,
    'points', coalesce(target.points, 0),
    'createdAt', target.created_at,
    'uploads', uploads,
    'saves', saves,
    'notes', notes,
    'auditEntries', audit_entries,
    'isSelf', p_user_id = (select auth.uid())
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The delete itself.
-- ---------------------------------------------------------------------------
create or replace function public.delete_user_admin(
  p_user_id uuid,
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
  remaining_uploads integer;
  audit_entries integer;
begin
  if not (select public.is_admin()) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  -- Deleting yourself revokes your own session mid-call and leaves nobody able
  -- to undo it.
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot delete the account you are signed in with.' using errcode = '42501';
  end if;

  select * into before_row from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  select email into target_email from auth.users where id = p_user_id;

  -- resources.uploader_id is ON DELETE NO ACTION, so the documents have to be
  -- gone first. The caller removes them through the audited R2 path; refusing
  -- here keeps a direct RPC call from orphaning files in the bucket.
  select count(*) into remaining_uploads from public.resources where uploader_id = p_user_id;
  if remaining_uploads > 0 then
    raise exception 'Still owns % document(s). Remove them first so their files leave storage.', remaining_uploads
      using errcode = '23503';
  end if;

  select count(*) into audit_entries from public.admin_audit_log where actor_id = p_user_id;
  if audit_entries > 0 then
    raise exception 'This account wrote % audit entries and cannot be deleted without breaking the audit trail.', audit_entries
      using errcode = '23503';
  end if;

  -- Provenance columns, not history: keep the catalogue row, drop the pointer.
  update public.courses set proposed_by = null where proposed_by = p_user_id;
  update public.universities set proposed_by = null where proposed_by = p_user_id;
  update public.resources set moderated_by = null where moderated_by = p_user_id;

  -- Recorded before the delete, because afterwards there is nothing to read.
  insert into public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) values (
    (select auth.uid()), 'user.delete', 'profile', p_user_id, p_request_id,
    to_jsonb(before_row),
    jsonb_build_object('email', coalesce(target_email, ''), 'reason', 'Account deleted from the admin console')
  );

  -- Cascades profiles, resource_bookmarks, study_notes, identities, sessions.
  delete from auth.users where id = p_user_id;

  return jsonb_build_object('deleted', true, 'email', coalesce(target_email, ''));
end;
$$;

revoke all on function public.preflight_user_delete(uuid) from public, anon;
revoke all on function public.delete_user_admin(uuid, text) from public, anon;
grant execute on function public.preflight_user_delete(uuid) to authenticated;
grant execute on function public.delete_user_admin(uuid, text) to authenticated;
