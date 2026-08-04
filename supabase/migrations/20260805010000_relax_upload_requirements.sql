/*
  Make the upload form's optional fields actually optional.

  finalize_resource_upload was written when every field was mandatory. It
  rejected a NULL course and required a description of at least 10 characters,
  so no amount of front-end work could make either optional. The form also
  collected `subject`, which nothing meaningful reads and which users had no
  way to answer well.

  What stays mandatory: a title, an institution, and a real stored object.
  Everything else is either derived or genuinely optional.

  The signature is unchanged so the existing GRANT and the route's argument
  list keep working; only the validation inside it is relaxed.
*/

CREATE OR REPLACE FUNCTION public.finalize_resource_upload(
  p_storage_key text,
  p_original_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_title text,
  p_description text,
  p_university_id uuid,
  p_course_id uuid,
  p_category_id uuid,
  p_department text,
  p_course_code text,
  p_semester text,
  p_subject text,
  p_file_type text,
  p_tags text[],
  p_ai_requested boolean DEFAULT false
)
RETURNS public.resources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  inserted_resource public.resources;
  clean_description text := nullif(btrim(coalesce(p_description, '')), '');
  clean_semester text := nullif(btrim(coalesce(p_semester, '')), '');
  clean_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  clean_department text := nullif(btrim(coalesce(p_department, '')), '');
  clean_course_code text := nullif(btrim(coalesce(p_course_code, '')), '');
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.is_active_user()) THEN
    RAISE EXCEPTION 'This account cannot create resources.' USING ERRCODE = '42501';
  END IF;
  IF p_storage_key NOT LIKE ('resources/' || caller_id::text || '/%') OR position('..' IN p_storage_key) > 0 THEN
    RAISE EXCEPTION 'Storage key does not belong to the caller.' USING ERRCODE = '42501';
  END IF;
  IF p_size_bytes <= 0 OR p_size_bytes > 1073741824 THEN
    RAISE EXCEPTION 'Invalid resource size.' USING ERRCODE = '22023';
  END IF;
  IF p_file_type NOT IN ('pdf', 'ppt', 'docx', 'zip', 'img', 'xlsx', 'video') THEN
    RAISE EXCEPTION 'Invalid resource file type.' USING ERRCODE = '22023';
  END IF;

  -- Title is the one piece of prose we insist on.
  IF char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 3 AND 240 THEN
    RAISE EXCEPTION 'A title of 3 to 240 characters is required.' USING ERRCODE = '22023';
  END IF;
  -- Description is optional now, but still bounded when supplied.
  IF clean_description IS NOT NULL AND char_length(clean_description) > 5000 THEN
    RAISE EXCEPTION 'The description is too long.' USING ERRCODE = '22023';
  END IF;
  IF coalesce(array_length(p_tags, 1), 0) > 30 THEN
    RAISE EXCEPTION 'Too many resource tags.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.universities
  WHERE id = p_university_id
    AND (
      status = 'official'::public.record_status
      OR proposed_by = caller_id
      OR (SELECT public.is_admin())
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'University is unavailable.' USING ERRCODE = '22023';
  END IF;

  -- A course is optional. When one is named it must still belong to the
  -- chosen institution, so a resource cannot be filed under someone else's.
  IF p_course_id IS NOT NULL THEN
    PERFORM 1
    FROM public.courses
    WHERE id = p_course_id
      AND university_id = p_university_id
      AND (
        status = 'official'::public.record_status
        OR proposed_by = caller_id
        OR (SELECT public.is_admin())
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Course is unavailable or belongs to another university.' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_category_id IS NOT NULL THEN
    PERFORM 1 FROM public.categories WHERE id = p_category_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Category is unavailable.' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.resources (
    title, description, university_id, course_id, category_id, department,
    course_code, semester, subject, file_type, file_size, size_bytes,
    mime_type, original_file_name, checksum_sha256, uploader_id,
    storage_provider, storage_key, upload_finalized_at, status, tags,
    ai_status
  ) VALUES (
    btrim(p_title),
    clean_description,
    p_university_id,
    p_course_id,
    p_category_id,
    clean_department,
    CASE WHEN clean_course_code IS NULL THEN NULL
         ELSE public.normalize_course_code(clean_course_code) END,
    clean_semester,
    clean_subject,
    p_file_type,
    CASE
      WHEN p_size_bytes >= 1048576 THEN round(p_size_bytes / 1048576.0, 1)::text || ' MB'
      WHEN p_size_bytes >= 1024 THEN round(p_size_bytes / 1024.0, 1)::text || ' KB'
      ELSE p_size_bytes::text || ' B'
    END,
    p_size_bytes, p_mime_type, btrim(p_original_file_name),
    nullif(p_checksum_sha256, ''), caller_id, 'r2', p_storage_key, now(),
    'pending'::public.resource_status,
    coalesce(p_tags, '{}'::text[]),
    CASE WHEN p_ai_requested THEN 'queued'::public.ai_processing_status
         ELSE 'not_requested'::public.ai_processing_status END
  )
  RETURNING * INTO inserted_resource;

  IF p_ai_requested THEN
    INSERT INTO public.ai_processing_jobs (resource_id, status)
    VALUES (inserted_resource.id, 'queued'::public.ai_processing_status);
  END IF;

  RETURN inserted_resource;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_resource_upload(text, text, text, bigint, text, text, text, uuid, uuid, uuid, text, text, text, text, text, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_resource_upload(text, text, text, bigint, text, text, text, uuid, uuid, uuid, text, text, text, text, text, text[], boolean) TO authenticated;
