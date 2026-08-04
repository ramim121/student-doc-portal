/*
  Fix ambiguous column references in the admin delete functions.

  delete_category_admin(category_id uuid) failed at runtime with

    column reference "category_id" is ambiguous

  because the parameter shares its name with resources.category_id, so
  `WHERE category_id = before_row.id` could mean either. The course and
  university deletes carried the same latent flaw against resources.course_id,
  resources.university_id, profiles.university_id and courses.university_id -
  they simply had not been exercised yet.

  Parameters are renamed with a p_ prefix, matching finalize_resource_upload
  and complete_onboarding, and every count is table-qualified. Postgres cannot
  rename an input parameter through CREATE OR REPLACE, so each function is
  dropped first. Nothing calls these yet, so there is no compatibility window.
*/

DROP FUNCTION IF EXISTS public.delete_category_admin(uuid, text, text);
DROP FUNCTION IF EXISTS public.delete_course_admin(uuid, text, text);
DROP FUNCTION IF EXISTS public.delete_university_admin(uuid, text, text);

CREATE FUNCTION public.delete_category_admin(
  p_category_id uuid,
  p_reason text,
  p_request_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.categories;
  resource_count integer;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.categories WHERE id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category not found.' USING ERRCODE = 'P0002';
  END IF;

  -- resources.category_id is ON DELETE SET NULL, so deleting a category in use
  -- would silently uncategorise those resources. Refuse; merge instead.
  SELECT count(*) INTO resource_count
  FROM public.resources AS resource
  WHERE resource.category_id = before_row.id;

  IF resource_count > 0 THEN
    RAISE EXCEPTION
      'Still used by % resources. Merge it into another category instead.', resource_count
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.categories WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) VALUES (
    (SELECT auth.uid()), 'category.delete', 'category', before_row.id, p_request_id,
    to_jsonb(before_row), jsonb_build_object('reason', btrim(p_reason))
  );
END;
$$;

CREATE FUNCTION public.delete_course_admin(
  p_course_id uuid,
  p_reason text,
  p_request_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.courses;
  resource_count integer;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Course not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO resource_count
  FROM public.resources AS resource
  WHERE resource.course_id = before_row.id;

  IF resource_count > 0 THEN
    RAISE EXCEPTION
      'Still in use by % resources. Merge it into another course instead.', resource_count
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.courses WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) VALUES (
    (SELECT auth.uid()), 'course.delete', 'course', before_row.id, p_request_id,
    to_jsonb(before_row), jsonb_build_object('reason', btrim(p_reason))
  );
END;
$$;

CREATE FUNCTION public.delete_university_admin(
  p_university_id uuid,
  p_reason text,
  p_request_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.universities;
  resource_count integer;
  profile_count integer;
  course_count integer;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.universities WHERE id = p_university_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Institution not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO resource_count
  FROM public.resources AS resource
  WHERE resource.university_id = before_row.id;

  SELECT count(*) INTO profile_count
  FROM public.profiles AS profile
  WHERE profile.university_id = before_row.id;

  SELECT count(*) INTO course_count
  FROM public.courses AS course
  WHERE course.university_id = before_row.id;

  IF resource_count > 0 OR profile_count > 0 THEN
    RAISE EXCEPTION
      'Still in use: % resources and % members. Merge it into another institution instead.',
      resource_count, profile_count
      USING ERRCODE = '23503';
  END IF;

  -- Courses and reference data belong to the institution, not independently.
  DELETE FROM public.courses AS course WHERE course.university_id = before_row.id;
  DELETE FROM public.departments AS department WHERE department.university_id = before_row.id;
  DELETE FROM public.subjects AS subject WHERE subject.university_id = before_row.id;
  DELETE FROM public.universities WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) VALUES (
    (SELECT auth.uid()), 'university.delete', 'university', before_row.id, p_request_id,
    to_jsonb(before_row),
    jsonb_build_object('reason', btrim(p_reason), 'coursesRemoved', course_count)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_category_admin(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_course_admin(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_university_admin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_category_admin(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_course_admin(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_university_admin(uuid, text, text) TO authenticated;
