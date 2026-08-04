/*
  Bring Universities, Courses and Categories to the same level of admin
  control: create, read with real counts, update, delete and merge.

  Before this, administrators could update and merge universities and courses
  but could not create or delete either, and categories had no administrative
  surface at all - they could only be changed by editing a seed migration.

  Deletion policy, consistent across all three: refuse when the record is still
  referenced, and say what references it. categories.category_id is
  ON DELETE SET NULL, so deleting a category in use would have quietly
  uncategorised every resource that used it - exactly the kind of invisible
  data loss this refuses to perform. Merge is the supported path.
*/

-- ---------------------------------------------------------------------------
-- Universities: create and delete
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_university_admin(
  new_name text,
  new_short text,
  new_country text,
  new_institution_type public.institution_type DEFAULT 'university',
  new_status public.record_status DEFAULT 'official'
)
RETURNS public.universities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  created_row public.universities;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(new_name, ''))) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'Name must contain 2 to 200 characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(coalesce(new_short, ''))) NOT BETWEEN 2 AND 20 THEN
    RAISE EXCEPTION 'Short code must contain 2 to 20 characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(coalesce(new_country, ''))) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'A country is required.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.universities
    WHERE normalized_name = public.normalize_catalog_name(new_name)
  ) THEN
    RAISE EXCEPTION 'An institution with that name already exists.' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.universities (name, short, country, institution_type, status, color)
  VALUES (
    btrim(new_name), upper(btrim(new_short)), btrim(new_country),
    new_institution_type, new_status, 'from-indigo-600 to-blue-700'
  )
  RETURNING * INTO created_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, after_data)
  VALUES ((SELECT auth.uid()), 'university.create', 'university', created_row.id, to_jsonb(created_row));

  RETURN created_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_university_admin(
  university_id uuid,
  reason text,
  operation_request_id text DEFAULT NULL
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
  IF char_length(btrim(coalesce(reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.universities WHERE id = university_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Institution not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO resource_count FROM public.resources WHERE university_id = before_row.id;
  SELECT count(*) INTO profile_count FROM public.profiles WHERE university_id = before_row.id;
  SELECT count(*) INTO course_count FROM public.courses WHERE university_id = before_row.id;

  IF resource_count > 0 OR profile_count > 0 THEN
    RAISE EXCEPTION
      'Still in use: % resources and % members. Merge it into another institution instead.',
      resource_count, profile_count
      USING ERRCODE = '23503';
  END IF;

  -- Courses and reference data belong to the institution, not independently.
  DELETE FROM public.courses WHERE university_id = before_row.id;
  DELETE FROM public.departments WHERE university_id = before_row.id;
  DELETE FROM public.subjects WHERE university_id = before_row.id;
  DELETE FROM public.universities WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) VALUES (
    (SELECT auth.uid()), 'university.delete', 'university', before_row.id, operation_request_id,
    to_jsonb(before_row),
    jsonb_build_object('reason', btrim(reason), 'coursesRemoved', course_count)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_university_admin(text, text, text, public.institution_type, public.record_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_university_admin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_university_admin(text, text, text, public.institution_type, public.record_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_university_admin(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Courses: create and delete
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_course_admin(
  p_university_id uuid,
  new_code text,
  new_title text,
  new_description text DEFAULT NULL,
  new_status public.record_status DEFAULT 'official'
)
RETURNS public.courses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  created_row public.courses;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(public.normalize_course_code(coalesce(new_code, ''))) NOT BETWEEN 2 AND 32 THEN
    RAISE EXCEPTION 'Course code must contain 2 to 32 normalized characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(coalesce(new_title, ''))) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'Course title must contain 2 to 200 characters.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.universities WHERE id = p_university_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Institution not found.' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.courses
    WHERE university_id = p_university_id
      AND normalized_code = public.normalize_course_code(new_code)
  ) THEN
    RAISE EXCEPTION 'That course code already exists for this institution.' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.courses (university_id, code, title, description, status)
  VALUES (
    p_university_id, new_code, btrim(new_title),
    nullif(btrim(coalesce(new_description, '')), ''), new_status
  )
  RETURNING * INTO created_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, after_data)
  VALUES ((SELECT auth.uid()), 'course.create', 'course', created_row.id, to_jsonb(created_row));

  RETURN created_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_course_admin(
  course_id uuid,
  reason text,
  operation_request_id text DEFAULT NULL
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
  IF char_length(btrim(coalesce(reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.courses WHERE id = course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Course not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO resource_count FROM public.resources WHERE course_id = before_row.id;
  IF resource_count > 0 THEN
    RAISE EXCEPTION
      'Still in use by % resources. Merge it into another course instead.', resource_count
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.courses WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) VALUES (
    (SELECT auth.uid()), 'course.delete', 'course', before_row.id, operation_request_id,
    to_jsonb(before_row), jsonb_build_object('reason', btrim(reason))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_course_admin(uuid, text, text, text, public.record_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_course_admin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_course_admin(uuid, text, text, text, public.record_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_course_admin(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Categories: the whole surface, which did not exist
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_categories()
RETURNS TABLE (
  id uuid,
  name text,
  icon text,
  description text,
  resource_count bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    category.id, category.name, category.icon, category.description,
    (SELECT count(*) FROM public.resources AS resource WHERE resource.category_id = category.id),
    category.created_at
  FROM public.categories AS category
  ORDER BY category.name, category.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_category_admin(
  new_name text,
  new_icon text DEFAULT NULL,
  new_description text DEFAULT NULL
)
RETURNS public.categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  created_row public.categories;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(new_name, ''))) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Category name must contain 2 to 80 characters.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.categories WHERE lower(name) = lower(btrim(new_name))) THEN
    RAISE EXCEPTION 'That category already exists.' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.categories (name, icon, description)
  VALUES (
    btrim(new_name),
    nullif(btrim(coalesce(new_icon, '')), ''),
    nullif(btrim(coalesce(new_description, '')), '')
  )
  RETURNING * INTO created_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, after_data)
  VALUES ((SELECT auth.uid()), 'category.create', 'category', created_row.id, to_jsonb(created_row));

  RETURN created_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_category_admin(
  category_id uuid,
  new_name text,
  new_icon text DEFAULT NULL,
  new_description text DEFAULT NULL
)
RETURNS public.categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.categories;
  after_row public.categories;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(new_name, ''))) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Category name must contain 2 to 80 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.categories WHERE id = category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category not found.' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.categories
    WHERE lower(name) = lower(btrim(new_name)) AND id <> category_id
  ) THEN
    RAISE EXCEPTION 'Another category already uses that name.' USING ERRCODE = '23505';
  END IF;

  UPDATE public.categories
  SET name = btrim(new_name),
      icon = nullif(btrim(coalesce(new_icon, '')), ''),
      description = nullif(btrim(coalesce(new_description, '')), '')
  WHERE id = category_id
  RETURNING * INTO after_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), 'category.update', 'category', category_id, to_jsonb(before_row), to_jsonb(after_row));

  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_category_admin(
  category_id uuid,
  reason text,
  operation_request_id text DEFAULT NULL
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
  IF char_length(btrim(coalesce(reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.categories WHERE id = category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category not found.' USING ERRCODE = 'P0002';
  END IF;

  -- resources.category_id is ON DELETE SET NULL, so deleting a category in use
  -- would silently uncategorise those resources. Refuse; merge instead.
  SELECT count(*) INTO resource_count FROM public.resources WHERE category_id = before_row.id;
  IF resource_count > 0 THEN
    RAISE EXCEPTION
      'Still used by % resources. Merge it into another category instead.', resource_count
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.categories WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, details
  ) VALUES (
    (SELECT auth.uid()), 'category.delete', 'category', before_row.id, operation_request_id,
    to_jsonb(before_row), jsonb_build_object('reason', btrim(reason))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_categories(
  source_category_id uuid,
  target_category_id uuid,
  operation_request_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_row public.categories;
  target_row public.categories;
  moved integer;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF source_category_id = target_category_id THEN
    RAISE EXCEPTION 'Source and target category cannot be identical.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO source_row FROM public.categories WHERE id = source_category_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source category not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO target_row FROM public.categories WHERE id = target_category_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target category not found.' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.resources SET category_id = target_category_id WHERE category_id = source_category_id;
  GET DIAGNOSTICS moved = ROW_COUNT;

  DELETE FROM public.categories WHERE id = source_category_id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id, before_data, after_data, details
  ) VALUES (
    (SELECT auth.uid()), 'category.merge', 'category', target_category_id, operation_request_id,
    to_jsonb(source_row), to_jsonb(target_row),
    jsonb_build_object('resourcesMoved', moved)
  );

  RETURN moved;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_categories() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_category_admin(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_category_admin(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_category_admin(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merge_categories(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_categories() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_category_admin(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_category_admin(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_category_admin(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_categories(uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Institution listing for the admin screen: every status, with real counts.
-- The public list_institutions only returns official records.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_universities(
  query_text text DEFAULT '',
  page_number integer DEFAULT 1,
  page_size integer DEFAULT 25
)
RETURNS TABLE (
  id uuid,
  name text,
  short text,
  country text,
  institution_type public.institution_type,
  status public.record_status,
  departments_count integer,
  course_count bigint,
  resource_count bigint,
  member_count bigint,
  created_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_query text := lower(btrim(coalesce(query_text, '')));
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 25), 1), 100);
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT
      university.id, university.name, university.short, university.country,
      university.institution_type, university.status, university.departments_count,
      (SELECT count(*) FROM public.courses AS course WHERE course.university_id = university.id) AS course_count,
      (SELECT count(*) FROM public.resources AS resource WHERE resource.university_id = university.id) AS resource_count,
      (SELECT count(*) FROM public.profiles AS profile WHERE profile.university_id = university.id) AS member_count,
      university.created_at
    FROM public.universities AS university
    WHERE normalized_query = ''
       OR lower(university.name) LIKE '%' || normalized_query || '%'
       OR lower(university.short) LIKE '%' || normalized_query || '%'
       OR lower(university.country) LIKE '%' || normalized_query || '%'
  ),
  counted AS (SELECT matched.*, count(*) OVER() AS result_total FROM matched)
  SELECT
    counted.id, counted.name, counted.short, counted.country,
    counted.institution_type, counted.status, counted.departments_count,
    counted.course_count, counted.resource_count, counted.member_count,
    counted.created_at, counted.result_total
  FROM counted
  ORDER BY counted.name, counted.id
  OFFSET (safe_page - 1) * safe_size
  LIMIT safe_size;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_universities(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_universities(text, integer, integer) TO authenticated;
