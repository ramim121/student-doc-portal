/*
  Phase 2 lifecycle, privacy, normalization, audit, and live-search foundation.

  Upgrade policy:
  - Legacy resources are deliberately backfilled to `pending`; they require an
    administrator review before becoming publicly visible.
  - `file_path` and `file_url` remain temporarily for rollback compatibility.
    New code uses `storage_provider` + `storage_key` exclusively.
  - Existing pending university/course proposals without an owner remain
    visible to administrators only.
*/

-- ---------------------------------------------------------------------------
-- Canonical lifecycle types
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE TYPE public.resource_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'removed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE public.ai_processing_status AS ENUM (
    'not_requested',
    'queued',
    'processing',
    'completed',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE public.cleanup_job_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE public.account_status AS ENUM ('active', 'suspended', 'deleted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Normalization helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_catalog_name(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT lower(regexp_replace(btrim(value), '\s+', ' ', 'g'));
$$;

CREATE OR REPLACE FUNCTION public.normalize_course_code(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT trim(
    BOTH '-' FROM upper(regexp_replace(btrim(value), '[^a-zA-Z0-9]+', '-', 'g'))
  );
$$;

REVOKE ALL ON FUNCTION public.normalize_catalog_name(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_course_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_catalog_name(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_course_code(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Catalog ownership and normalized uniqueness
-- ---------------------------------------------------------------------------

ALTER TABLE public.universities
  ADD COLUMN IF NOT EXISTS proposed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS normalized_name text;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS proposed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS normalized_code text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_status public.account_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_reason text;

ALTER TABLE public.universities
  ALTER COLUMN proposed_by SET DEFAULT auth.uid();

ALTER TABLE public.courses
  ALTER COLUMN proposed_by SET DEFAULT auth.uid();

UPDATE public.universities
SET normalized_name = public.normalize_catalog_name(name)
WHERE normalized_name IS NULL
   OR normalized_name <> public.normalize_catalog_name(name);

UPDATE public.courses
SET code = public.normalize_course_code(code),
    normalized_code = public.normalize_course_code(code)
WHERE normalized_code IS NULL
   OR normalized_code <> public.normalize_course_code(code)
   OR code <> public.normalize_course_code(code);

ALTER TABLE public.universities
  ALTER COLUMN normalized_name SET NOT NULL;

ALTER TABLE public.courses
  ALTER COLUMN normalized_code SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_catalog_normalized_values()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'universities' THEN
    NEW.name := btrim(NEW.name);
    NEW.short := upper(btrim(NEW.short));
    NEW.normalized_name := public.normalize_catalog_name(NEW.name);
  ELSIF TG_TABLE_NAME = 'courses' THEN
    NEW.code := public.normalize_course_code(NEW.code);
    NEW.title := btrim(NEW.title);
    NEW.normalized_code := NEW.code;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_catalog_normalized_values() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS universities_normalize_values ON public.universities;
CREATE TRIGGER universities_normalize_values
BEFORE INSERT OR UPDATE OF name, short ON public.universities
FOR EACH ROW
EXECUTE FUNCTION public.set_catalog_normalized_values();

DROP TRIGGER IF EXISTS courses_normalize_values ON public.courses;
CREATE TRIGGER courses_normalize_values
BEFORE INSERT OR UPDATE OF code, title ON public.courses
FOR EACH ROW
EXECUTE FUNCTION public.set_catalog_normalized_values();

-- Fail safely instead of silently merging ambiguous production data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.universities
    GROUP BY normalized_name
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate normalized university names exist. Resolve them with the reviewed merge workflow before applying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.courses
    GROUP BY university_id, normalized_code
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate normalized course codes exist. Resolve them with the reviewed merge workflow before applying this migration.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_universities_normalized_name
  ON public.universities(normalized_name);

CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_university_normalized_code
  ON public.courses(university_id, normalized_code);

CREATE INDEX IF NOT EXISTS idx_universities_status_name
  ON public.universities(status, normalized_name);

CREATE INDEX IF NOT EXISTS idx_courses_status_university_code
  ON public.courses(status, university_id, normalized_code);

-- ---------------------------------------------------------------------------
-- Resource lifecycle and machine-readable storage metadata
-- ---------------------------------------------------------------------------

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS status public.resource_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS original_file_name text,
  ADD COLUMN IF NOT EXISTS checksum_sha256 text,
  ADD COLUMN IF NOT EXISTS upload_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS moderation_reason text,
  ADD COLUMN IF NOT EXISTS ai_status public.ai_processing_status NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS ai_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_error_code text,
  ADD COLUMN IF NOT EXISTS ai_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.resources.file_path IS
  'Legacy Supabase Storage path. Retained during the storage_key migration window; do not write from new code.';
COMMENT ON COLUMN public.resources.file_url IS
  'Legacy URL. Retained during the storage_key migration window; do not write signed or permanent URLs here.';

ALTER TABLE public.resources
  DROP CONSTRAINT IF EXISTS resources_size_bytes_positive,
  ADD CONSTRAINT resources_size_bytes_positive
    CHECK (size_bytes IS NULL OR size_bytes > 0),
  DROP CONSTRAINT IF EXISTS resources_ai_attempts_nonnegative,
  ADD CONSTRAINT resources_ai_attempts_nonnegative
    CHECK (ai_attempts >= 0),
  DROP CONSTRAINT IF EXISTS resources_counters_nonnegative,
  ADD CONSTRAINT resources_counters_nonnegative
    CHECK (
      downloads >= 0 AND views >= 0 AND bookmarks >= 0
      AND rating_count >= 0 AND (pages IS NULL OR pages >= 0)
    ),
  DROP CONSTRAINT IF EXISTS resources_rating_range,
  ADD CONSTRAINT resources_rating_range
    CHECK (rating >= 0 AND rating <= 5),
  DROP CONSTRAINT IF EXISTS resources_storage_provider_allowed,
  ADD CONSTRAINT resources_storage_provider_allowed
    CHECK (storage_provider IN ('r2', 'supabase')),
  DROP CONSTRAINT IF EXISTS resources_mime_type_allowed,
  ADD CONSTRAINT resources_mime_type_allowed
    CHECK (
      mime_type IS NULL OR mime_type IN (
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/zip',
        'application/x-zip-compressed',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/webm',
        'video/quicktime'
      )
    );

-- The previous schema had no trustworthy moderation signal. Existing rows are
-- intentionally review-required instead of becoming public by accident.
UPDATE public.resources
SET status = 'pending'::public.resource_status
WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_resources_public_discovery
  ON public.resources(status, created_at DESC, id DESC)
  WHERE status = 'approved'::public.resource_status;

CREATE INDEX IF NOT EXISTS idx_resources_moderation_queue
  ON public.resources(status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_resources_uploader_status
  ON public.resources(uploader_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_resources_ai_queue
  ON public.resources(ai_status, ai_updated_at NULLS FIRST)
  WHERE ai_status IN ('queued'::public.ai_processing_status, 'failed'::public.ai_processing_status);

CREATE INDEX IF NOT EXISTS idx_resources_tags_gin
  ON public.resources USING gin(tags);

CREATE INDEX IF NOT EXISTS idx_resources_ai_topics_gin
  ON public.resources USING gin(ai_topics);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.resources
    WHERE storage_key IS NOT NULL
    GROUP BY storage_provider, storage_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate resource storage keys exist. Resolve them before applying the finalization uniqueness constraint.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_storage_object
  ON public.resources(storage_provider, storage_key)
  WHERE storage_key IS NOT NULL;

-- array_to_string(anyarray, text) is STABLE, not IMMUTABLE, so it cannot appear
-- directly in an index expression. This wrapper pins the element type to text,
-- where the conversion is genuinely deterministic, and is declared IMMUTABLE so
-- the expression becomes indexable.
CREATE OR REPLACE FUNCTION public.resource_search_document(
  p_title text,
  p_description text,
  p_course_code text,
  p_subject text,
  p_tags text[],
  p_ai_topics text[]
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT to_tsvector(
    'simple'::regconfig,
    coalesce(p_title, '') || ' ' ||
    coalesce(p_description, '') || ' ' ||
    coalesce(p_course_code, '') || ' ' ||
    coalesce(p_subject, '') || ' ' ||
    coalesce(array_to_string(p_tags, ' '), '') || ' ' ||
    coalesce(array_to_string(p_ai_topics, ' '), '')
  );
$$;

REVOKE ALL ON FUNCTION public.resource_search_document(text, text, text, text, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resource_search_document(text, text, text, text, text[], text[]) TO anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_resources_search_document
  ON public.resources USING gin(
    public.resource_search_document(
      title, description, course_code, subject, tags, ai_topics
    )
  );

-- ---------------------------------------------------------------------------
-- Audit and retryable object cleanup
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 100),
  target_type text NOT NULL CHECK (char_length(target_type) BETWEEN 2 AND 80),
  target_id uuid,
  request_id text,
  before_data jsonb,
  after_data jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
  ON public.admin_audit_log(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target
  ON public.admin_audit_log(target_type, target_id, created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_read_audit_log" ON public.admin_audit_log;
CREATE POLICY "admin_read_audit_log"
ON public.admin_audit_log
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin()));

CREATE TABLE IF NOT EXISTS public.storage_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid REFERENCES public.resources(id) ON DELETE SET NULL,
  storage_provider text NOT NULL CHECK (storage_provider IN ('r2', 'supabase')),
  storage_key text NOT NULL,
  reason text NOT NULL,
  status public.cleanup_job_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(storage_provider, storage_key, status)
);

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_work
  ON public.storage_cleanup_jobs(status, next_attempt_at, id)
  WHERE status IN ('pending'::public.cleanup_job_status, 'failed'::public.cleanup_job_status);

ALTER TABLE public.storage_cleanup_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_read_cleanup_jobs" ON public.storage_cleanup_jobs;
CREATE POLICY "admin_read_cleanup_jobs"
ON public.storage_cleanup_jobs
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin()));

CREATE TABLE IF NOT EXISTS public.ai_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL UNIQUE REFERENCES public.resources(id) ON DELETE CASCADE,
  status public.ai_processing_status NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by uuid,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_processing_jobs_work
  ON public.ai_processing_jobs(status, next_attempt_at, id)
  WHERE status IN ('queued'::public.ai_processing_status, 'failed'::public.ai_processing_status);

ALTER TABLE public.ai_processing_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_read_ai_jobs" ON public.ai_processing_jobs;
CREATE POLICY "admin_read_ai_jobs"
ON public.ai_processing_jobs
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin()));

CREATE TABLE IF NOT EXISTS public.api_rate_limit_buckets (
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, action, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limit_buckets_expiry
  ON public.api_rate_limit_buckets(expires_at);

ALTER TABLE public.api_rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar)
  VALUES (
    NEW.id,
    coalesce(NEW.raw_user_meta_data->>'full_name', 'Anonymous'),
    coalesce(
      NEW.raw_user_meta_data->>'avatar',
      upper(left(coalesce(NEW.raw_user_meta_data->>'full_name', 'A'), 2))
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS resources_set_updated_at ON public.resources;
CREATE TRIGGER resources_set_updated_at
BEFORE UPDATE ON public.resources
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS cleanup_jobs_set_updated_at ON public.storage_cleanup_jobs;
CREATE TRIGGER cleanup_jobs_set_updated_at
BEFORE UPDATE ON public.storage_cleanup_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS ai_jobs_set_updated_at ON public.ai_processing_jobs;
CREATE TRIGGER ai_jobs_set_updated_at
BEFORE UPDATE ON public.ai_processing_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Public privacy and proposal visibility
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "public_read_profiles" ON public.profiles;
CREATE POLICY "public_read_profiles"
ON public.profiles
FOR SELECT
TO anon, authenticated
USING (true);

REVOKE SELECT ON public.profiles FROM anon, authenticated;
GRANT SELECT (
  id, full_name, avatar, university_id, points, level, uploads, downloads,
  badge, verified, created_at
) ON public.profiles TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND account_status = 'active'::public.account_status
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'::public.user_role
      AND account_status = 'active'::public.account_status
  );
$$;

REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN account_status = 'active'::public.account_status THEN role ELSE NULL END
  FROM public.profiles
  WHERE id = (SELECT auth.uid());
$$;

REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_account_status()
RETURNS public.account_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT account_status FROM public.profiles WHERE id = (SELECT auth.uid());
$$;

REVOKE ALL ON FUNCTION public.get_my_account_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_account_status() TO authenticated;

DROP POLICY IF EXISTS "public_read_universities" ON public.universities;
DROP POLICY IF EXISTS "official_read_universities" ON public.universities;
CREATE POLICY "official_read_universities"
ON public.universities
FOR SELECT
TO anon, authenticated
USING (status = 'official'::public.record_status);

DROP POLICY IF EXISTS "owner_read_proposed_universities" ON public.universities;
CREATE POLICY "owner_read_proposed_universities"
ON public.universities
FOR SELECT
TO authenticated
USING (proposed_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS "authenticated_propose_universities" ON public.universities;
CREATE POLICY "authenticated_propose_universities"
ON public.universities
FOR INSERT
TO authenticated
WITH CHECK (
  status = 'custom_pending'::public.record_status
  AND proposed_by = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
);

DROP POLICY IF EXISTS "public_read_courses" ON public.courses;
DROP POLICY IF EXISTS "official_read_courses" ON public.courses;
CREATE POLICY "official_read_courses"
ON public.courses
FOR SELECT
TO anon, authenticated
USING (status = 'official'::public.record_status);

DROP POLICY IF EXISTS "owner_read_proposed_courses" ON public.courses;
CREATE POLICY "owner_read_proposed_courses"
ON public.courses
FOR SELECT
TO authenticated
USING (proposed_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS "authenticated_propose_courses" ON public.courses;
CREATE POLICY "authenticated_propose_courses"
ON public.courses
FOR INSERT
TO authenticated
WITH CHECK (
  status = 'custom_pending'::public.record_status
  AND proposed_by = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
);

DROP POLICY IF EXISTS "admin_manage_universities" ON public.universities;
DROP POLICY IF EXISTS "admin_read_all_universities" ON public.universities;
CREATE POLICY "admin_read_all_universities"
ON public.universities
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "admin_manage_courses" ON public.courses;
DROP POLICY IF EXISTS "admin_read_all_courses" ON public.courses;
CREATE POLICY "admin_read_all_courses"
ON public.courses
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin()));

-- ---------------------------------------------------------------------------
-- Resource visibility and least-privilege mutation
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "public_read_resources" ON public.resources;
DROP POLICY IF EXISTS "public_read_approved_resources" ON public.resources;
CREATE POLICY "public_read_approved_resources"
ON public.resources
FOR SELECT
TO anon, authenticated
USING (status = 'approved'::public.resource_status);

DROP POLICY IF EXISTS "owner_read_resources" ON public.resources;
CREATE POLICY "owner_read_resources"
ON public.resources
FOR SELECT
TO authenticated
USING (uploader_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "insert_own_resources" ON public.resources;
CREATE POLICY "insert_own_resources"
ON public.resources
FOR INSERT
TO authenticated
WITH CHECK (
  uploader_id = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
  AND status = 'pending'::public.resource_status
  AND storage_key LIKE ('resources/' || (SELECT auth.uid())::text || '/%')
);

DROP POLICY IF EXISTS "update_own_resources" ON public.resources;
CREATE POLICY "update_own_resources"
ON public.resources
FOR UPDATE
TO authenticated
USING (uploader_id = (SELECT auth.uid()))
WITH CHECK (uploader_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "delete_own_resources" ON public.resources;

DROP POLICY IF EXISTS "admin_manage_resources" ON public.resources;
DROP POLICY IF EXISTS "admin_read_all_resources" ON public.resources;
CREATE POLICY "admin_read_all_resources"
ON public.resources
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin()));

REVOKE UPDATE ON public.resources FROM authenticated;
GRANT UPDATE (
  title, description, university_id, course_id, category_id, department,
  course_code, semester, subject, tags
) ON public.resources TO authenticated;

DROP POLICY IF EXISTS "insert_own_study_notes" ON public.study_notes;
CREATE POLICY "insert_own_study_notes"
ON public.study_notes
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
);

DROP POLICY IF EXISTS "update_own_study_notes" ON public.study_notes;
CREATE POLICY "update_own_study_notes"
ON public.study_notes
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
);

DROP POLICY IF EXISTS "delete_own_study_notes" ON public.study_notes;
CREATE POLICY "delete_own_study_notes"
ON public.study_notes
FOR DELETE
TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
);

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
  IF char_length(btrim(p_title)) NOT BETWEEN 3 AND 240 OR char_length(btrim(p_description)) NOT BETWEEN 10 AND 5000 THEN
    RAISE EXCEPTION 'Invalid resource title or description.' USING ERRCODE = '22023';
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
  IF NOT FOUND THEN RAISE EXCEPTION 'University is unavailable.' USING ERRCODE = '22023'; END IF;

  PERFORM 1
  FROM public.courses
  WHERE id = p_course_id
    AND university_id = p_university_id
    AND (
      status = 'official'::public.record_status
      OR proposed_by = caller_id
      OR (SELECT public.is_admin())
    );
  IF NOT FOUND THEN RAISE EXCEPTION 'Course is unavailable or belongs to another university.' USING ERRCODE = '22023'; END IF;

  IF p_category_id IS NOT NULL THEN
    PERFORM 1 FROM public.categories WHERE id = p_category_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Category is unavailable.' USING ERRCODE = '22023'; END IF;
  END IF;

  INSERT INTO public.resources (
    title, description, university_id, course_id, category_id, department,
    course_code, semester, subject, file_type, file_size, size_bytes,
    mime_type, original_file_name, checksum_sha256, uploader_id,
    storage_provider, storage_key, upload_finalized_at, status, tags,
    ai_status
  ) VALUES (
    btrim(p_title), btrim(p_description), p_university_id, p_course_id,
    p_category_id, btrim(p_department), public.normalize_course_code(p_course_code),
    btrim(p_semester), btrim(p_subject), p_file_type,
    CASE
      WHEN p_size_bytes >= 1048576 THEN round(p_size_bytes / 1048576.0, 1)::text || ' MB'
      WHEN p_size_bytes >= 1024 THEN round(p_size_bytes / 1024.0, 1)::text || ' KB'
      ELSE p_size_bytes::text || ' B'
    END,
    p_size_bytes, p_mime_type, btrim(p_original_file_name),
    nullif(p_checksum_sha256, ''), caller_id, 'r2', p_storage_key, now(),
    'pending'::public.resource_status,
    coalesce(p_tags, '{}'::text[]),
    CASE WHEN p_ai_requested THEN 'queued'::public.ai_processing_status ELSE 'not_requested'::public.ai_processing_status END
  )
  RETURNING * INTO inserted_resource;

  IF p_ai_requested THEN
    INSERT INTO public.ai_processing_jobs (resource_id, status)
    VALUES (inserted_resource.id, 'queued'::public.ai_processing_status);
  END IF;

  RETURN inserted_resource;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_own_storage_cleanup(
  p_storage_key text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
BEGIN
  IF caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501'; END IF;
  IF NOT (SELECT public.is_active_user()) THEN RAISE EXCEPTION 'This account cannot create cleanup jobs.' USING ERRCODE = '42501'; END IF;
  IF p_storage_key NOT LIKE ('resources/' || caller_id::text || '/%') OR position('..' IN p_storage_key) > 0 THEN
    RAISE EXCEPTION 'Storage key does not belong to the caller.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(p_reason)) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'Invalid cleanup reason.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.storage_cleanup_jobs (storage_provider, storage_key, reason)
  VALUES ('r2', p_storage_key, btrim(p_reason))
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_resource_upload(text, text, text, bigint, text, text, text, uuid, uuid, uuid, text, text, text, text, text, text[], boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enqueue_own_storage_cleanup(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_resource_upload(text, text, text, bigint, text, text, text, uuid, uuid, uuid, text, text, text, text, text, text[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_own_storage_cleanup(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.consume_api_rate_limit(p_action text)
RETURNS TABLE (allowed boolean, retry_after_seconds integer, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  normalized_action text := lower(btrim(p_action));
  request_limit integer;
  window_seconds integer;
  bucket_start timestamptz;
  current_count integer;
BEGIN
  IF caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501'; END IF;

  SELECT limits.request_limit, limits.window_seconds
  INTO request_limit, window_seconds
  FROM (VALUES
    ('upload.presign', 10, 60),
    ('upload.finalize', 10, 60),
    ('resource.download', 60, 60),
    ('ai.summarize', 10, 60)
  ) AS limits(action, request_limit, window_seconds)
  WHERE limits.action = normalized_action;

  IF request_limit IS NULL THEN
    RAISE EXCEPTION 'Unknown rate-limit action.' USING ERRCODE = '22023';
  END IF;

  bucket_start := to_timestamp(floor(extract(epoch FROM now()) / window_seconds) * window_seconds);
  INSERT INTO public.api_rate_limit_buckets (
    actor_id, action, window_started_at, request_count, expires_at
  ) VALUES (
    caller_id, normalized_action, bucket_start, 1,
    bucket_start + make_interval(secs => window_seconds * 2)
  )
  ON CONFLICT (actor_id, action, window_started_at)
  DO UPDATE SET request_count = public.api_rate_limit_buckets.request_count + 1
  RETURNING request_count INTO current_count;

  RETURN QUERY SELECT
    current_count <= request_limit,
    greatest(1, ceil(extract(epoch FROM (bucket_start + make_interval(secs => window_seconds) - now())))::integer),
    greatest(0, request_limit - current_count);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_api_rate_limit(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_api_rate_limit(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin moderation: authorization, mutation, and audit are one transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.moderate_resource(
  resource_id uuid,
  moderation_action text,
  reason text DEFAULT NULL,
  operation_request_id text DEFAULT NULL
)
RETURNS public.resources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.resources;
  after_row public.resources;
  normalized_action text := lower(btrim(moderation_action));
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO before_row
  FROM public.resources
  WHERE id = resource_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource not found.' USING ERRCODE = 'P0002';
  END IF;

  IF normalized_action = 'approve' THEN
    UPDATE public.resources
    SET status = 'approved'::public.resource_status,
        moderated_at = now(),
        moderated_by = (SELECT auth.uid()),
        moderation_reason = NULL
    WHERE id = resource_id
    RETURNING * INTO after_row;
  ELSIF normalized_action = 'reject' THEN
    IF nullif(btrim(reason), '') IS NULL THEN
      RAISE EXCEPTION 'A rejection reason is required.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.resources
    SET status = 'rejected'::public.resource_status,
        moderated_at = now(),
        moderated_by = (SELECT auth.uid()),
        moderation_reason = btrim(reason)
    WHERE id = resource_id
    RETURNING * INTO after_row;
  ELSIF normalized_action = 'remove' THEN
    IF nullif(btrim(reason), '') IS NULL THEN
      RAISE EXCEPTION 'A removal reason is required.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.resources
    SET status = 'removed'::public.resource_status,
        moderated_at = now(),
        moderated_by = (SELECT auth.uid()),
        moderation_reason = btrim(reason),
        featured = false,
        trending = false
    WHERE id = resource_id
    RETURNING * INTO after_row;
  ELSIF normalized_action = 'feature' THEN
    IF before_row.status <> 'approved'::public.resource_status THEN
      RAISE EXCEPTION 'Only approved resources can be featured.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.resources SET featured = true WHERE id = resource_id RETURNING * INTO after_row;
  ELSIF normalized_action = 'unfeature' THEN
    UPDATE public.resources SET featured = false WHERE id = resource_id RETURNING * INTO after_row;
  ELSE
    RAISE EXCEPTION 'Unsupported moderation action.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, request_id,
    before_data, after_data, details
  ) VALUES (
    (SELECT auth.uid()),
    'resource.' || normalized_action,
    'resource',
    resource_id,
    operation_request_id,
    to_jsonb(before_row),
    to_jsonb(after_row),
    jsonb_build_object('reason', reason)
  );

  RETURN after_row;
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_resource(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_resource(uuid, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.increment_resource_downloads(resource_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.is_active_user()) THEN
    RAISE EXCEPTION 'This account cannot download resources.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.resources AS resource
  SET downloads = downloads + 1
  WHERE id = resource_id
    AND (
      status = 'approved'::public.resource_status
      OR uploader_id = caller_id
      OR (SELECT public.is_admin())
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource not found or unavailable.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_resource_downloads(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_resource_downloads(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Collision-aware merge preflight and audited merge v2
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preflight_university_merge(
  source_univ_id uuid,
  target_univ_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_name text;
  target_name text;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF source_univ_id = target_univ_id THEN
    RAISE EXCEPTION 'Source and target university cannot be identical.' USING ERRCODE = '22023';
  END IF;

  SELECT name INTO source_name FROM public.universities WHERE id = source_univ_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source university not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT name INTO target_name FROM public.universities WHERE id = target_univ_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target university not found.' USING ERRCODE = 'P0002'; END IF;

  RETURN jsonb_build_object(
    'sourceName', source_name,
    'targetName', target_name,
    'affected', jsonb_build_object(
      'departments', (SELECT count(*) FROM public.departments WHERE university_id = source_univ_id),
      'subjects', (SELECT count(*) FROM public.subjects WHERE university_id = source_univ_id),
      'courses', (SELECT count(*) FROM public.courses WHERE university_id = source_univ_id),
      'profiles', (SELECT count(*) FROM public.profiles WHERE university_id = source_univ_id),
      'resources', (SELECT count(*) FROM public.resources WHERE university_id = source_univ_id)
    ),
    'conflicts', jsonb_build_object(
      'departments', coalesce((
        SELECT jsonb_agg(jsonb_build_object('sourceId', source_department.id, 'targetId', target_department.id, 'name', source_department.name))
        FROM public.departments AS source_department
        JOIN public.departments AS target_department
          ON target_department.university_id = target_univ_id
         AND public.normalize_catalog_name(target_department.name) = public.normalize_catalog_name(source_department.name)
        WHERE source_department.university_id = source_univ_id
      ), '[]'::jsonb),
      'subjects', coalesce((
        SELECT jsonb_agg(jsonb_build_object('sourceId', source_subject.id, 'targetId', target_subject.id, 'name', source_subject.name))
        FROM public.subjects AS source_subject
        JOIN public.subjects AS target_subject
          ON target_subject.university_id = target_univ_id
         AND public.normalize_catalog_name(target_subject.name) = public.normalize_catalog_name(source_subject.name)
         AND public.normalize_catalog_name(coalesce(target_subject.department, '')) = public.normalize_catalog_name(coalesce(source_subject.department, ''))
        WHERE source_subject.university_id = source_univ_id
      ), '[]'::jsonb),
      'courses', coalesce((
        SELECT jsonb_agg(jsonb_build_object('sourceId', source_course.id, 'targetId', target_course.id, 'code', source_course.code))
        FROM public.courses AS source_course
        JOIN public.courses AS target_course
          ON target_course.university_id = target_univ_id
         AND target_course.normalized_code = source_course.normalized_code
        WHERE source_course.university_id = source_univ_id
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preflight_university_merge(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preflight_university_merge(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.preflight_course_merge(
  source_course_id uuid,
  target_course_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_course public.courses;
  target_course public.courses;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF source_course_id = target_course_id THEN
    RAISE EXCEPTION 'Source and target course cannot be identical.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO source_course FROM public.courses WHERE id = source_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source course not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO target_course FROM public.courses WHERE id = target_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target course not found.' USING ERRCODE = 'P0002'; END IF;
  IF source_course.university_id <> target_course.university_id THEN
    RAISE EXCEPTION 'Courses from different universities cannot be merged.' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'sourceCode', source_course.code,
    'targetCode', target_course.code,
    'affectedResources', (SELECT count(*) FROM public.resources WHERE course_id = source_course_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preflight_course_merge(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preflight_course_merge(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.merge_universities(
  source_univ_id uuid,
  target_univ_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  locked_count integer;
  before_source jsonb;
  before_target jsonb;
  preflight jsonb;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF source_univ_id = target_univ_id THEN
    RAISE EXCEPTION 'Source and target university cannot be identical.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.universities
  WHERE id IN (source_univ_id, target_univ_id)
  ORDER BY id
  FOR UPDATE;
  GET DIAGNOSTICS locked_count = ROW_COUNT;
  IF locked_count <> 2 THEN
    RAISE EXCEPTION 'Source or target university not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT to_jsonb(university) INTO before_source FROM public.universities AS university WHERE id = source_univ_id;
  SELECT to_jsonb(university) INTO before_target FROM public.universities AS university WHERE id = target_univ_id;
  preflight := public.preflight_university_merge(source_univ_id, target_univ_id);

  -- Re-point resources from duplicate source courses before deleting them.
  UPDATE public.resources AS resource
  SET course_id = target_course.id
  FROM public.courses AS source_course
  JOIN public.courses AS target_course
    ON target_course.university_id = target_univ_id
   AND target_course.normalized_code = source_course.normalized_code
  WHERE source_course.university_id = source_univ_id
    AND resource.course_id = source_course.id;

  DELETE FROM public.courses AS source_course
  USING public.courses AS target_course
  WHERE source_course.university_id = source_univ_id
    AND target_course.university_id = target_univ_id
    AND target_course.normalized_code = source_course.normalized_code;

  DELETE FROM public.departments AS source_department
  USING public.departments AS target_department
  WHERE source_department.university_id = source_univ_id
    AND target_department.university_id = target_univ_id
    AND public.normalize_catalog_name(target_department.name) = public.normalize_catalog_name(source_department.name);

  DELETE FROM public.subjects AS source_subject
  USING public.subjects AS target_subject
  WHERE source_subject.university_id = source_univ_id
    AND target_subject.university_id = target_univ_id
    AND public.normalize_catalog_name(target_subject.name) = public.normalize_catalog_name(source_subject.name)
    AND public.normalize_catalog_name(coalesce(target_subject.department, '')) = public.normalize_catalog_name(coalesce(source_subject.department, ''));

  UPDATE public.departments SET university_id = target_univ_id WHERE university_id = source_univ_id;
  UPDATE public.subjects SET university_id = target_univ_id WHERE university_id = source_univ_id;
  UPDATE public.courses SET university_id = target_univ_id WHERE university_id = source_univ_id;
  UPDATE public.profiles SET university_id = target_univ_id WHERE university_id = source_univ_id;
  UPDATE public.resources SET university_id = target_univ_id WHERE university_id = source_univ_id;

  UPDATE public.universities
  SET departments_count = (SELECT count(*)::integer FROM public.departments WHERE university_id = target_univ_id)
  WHERE id = target_univ_id;

  DELETE FROM public.universities WHERE id = source_univ_id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, before_data, after_data, details
  ) VALUES (
    (SELECT auth.uid()), 'university.merge', 'university', target_univ_id,
    jsonb_build_object('source', before_source, 'target', before_target),
    (SELECT to_jsonb(university) FROM public.universities AS university WHERE id = target_univ_id),
    preflight
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_courses(
  source_course_id uuid,
  target_course_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_course public.courses;
  target_course public.courses;
  preflight jsonb;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF source_course_id = target_course_id THEN
    RAISE EXCEPTION 'Source and target course cannot be identical.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO source_course FROM public.courses WHERE id = source_course_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source course not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO target_course FROM public.courses WHERE id = target_course_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target course not found.' USING ERRCODE = 'P0002'; END IF;
  IF source_course.university_id <> target_course.university_id THEN
    RAISE EXCEPTION 'Courses from different universities cannot be merged.' USING ERRCODE = '22023';
  END IF;

  preflight := public.preflight_course_merge(source_course_id, target_course_id);
  UPDATE public.resources SET course_id = target_course_id WHERE course_id = source_course_id;
  DELETE FROM public.courses WHERE id = source_course_id;

  INSERT INTO public.admin_audit_log (
    actor_id, action, target_type, target_id, before_data, after_data, details
  ) VALUES (
    (SELECT auth.uid()), 'course.merge', 'course', target_course_id,
    to_jsonb(source_course), to_jsonb(target_course), preflight
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_universities(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merge_courses(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_universities(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_courses(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_university_admin(
  university_id uuid,
  new_name text,
  new_short text,
  new_status public.record_status
)
RETURNS public.universities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.universities;
  after_row public.universities;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(new_name)) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'University name must contain 2 to 200 characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(new_short)) NOT BETWEEN 2 AND 20 THEN
    RAISE EXCEPTION 'University short code must contain 2 to 20 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.universities WHERE id = university_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'University not found.' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.universities
  SET name = btrim(new_name), short = upper(btrim(new_short)), status = new_status
  WHERE id = university_id
  RETURNING * INTO after_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), 'university.update', 'university', university_id, to_jsonb(before_row), to_jsonb(after_row));
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_course_admin(
  course_id uuid,
  new_code text,
  new_title text,
  new_description text,
  new_status public.record_status
)
RETURNS public.courses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.courses;
  after_row public.courses;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(public.normalize_course_code(new_code)) NOT BETWEEN 2 AND 32 THEN
    RAISE EXCEPTION 'Course code must contain 2 to 32 normalized characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(new_title)) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'Course title must contain 2 to 200 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO before_row FROM public.courses WHERE id = course_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found.' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.courses
  SET code = new_code,
      title = btrim(new_title),
      description = nullif(btrim(new_description), ''),
      status = new_status
  WHERE id = course_id
  RETURNING * INTO after_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), 'course.update', 'course', course_id, to_jsonb(before_row), to_jsonb(after_row));
  RETURN after_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_university_admin(uuid, text, text, public.record_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_course_admin(uuid, text, text, text, public.record_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_university_admin(uuid, text, text, public.record_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_course_admin(uuid, text, text, text, public.record_status) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_dashboard_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'universities', jsonb_build_object(
      'total', (SELECT count(*) FROM public.universities),
      'pending', (SELECT count(*) FROM public.universities WHERE status = 'custom_pending'::public.record_status)
    ),
    'courses', jsonb_build_object(
      'total', (SELECT count(*) FROM public.courses),
      'pending', (SELECT count(*) FROM public.courses WHERE status = 'custom_pending'::public.record_status)
    ),
    'resources', jsonb_build_object(
      'total', (SELECT count(*) FROM public.resources),
      'pending', (SELECT count(*) FROM public.resources WHERE status = 'pending'::public.resource_status),
      'approved', (SELECT count(*) FROM public.resources WHERE status = 'approved'::public.resource_status),
      'rejected', (SELECT count(*) FROM public.resources WHERE status = 'rejected'::public.resource_status),
      'removed', (SELECT count(*) FROM public.resources WHERE status = 'removed'::public.resource_status)
    ),
    'failedAiJobs', (SELECT count(*) FROM public.resources WHERE ai_status = 'failed'::public.ai_processing_status),
    'pendingCleanupJobs', (
      SELECT count(*) FROM public.storage_cleanup_jobs
      WHERE status IN ('pending'::public.cleanup_job_status, 'failed'::public.cleanup_job_status)
    ),
    'recentActivity', coalesce((
      SELECT jsonb_agg(activity ORDER BY activity.created_at DESC)
      FROM (
        SELECT id, actor_id, action, target_type, target_id, request_id, created_at
        FROM public.admin_audit_log
        ORDER BY created_at DESC
        LIMIT 10
      ) AS activity
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_dashboard_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_users(
  query_text text DEFAULT '',
  page_number integer DEFAULT 1,
  page_size integer DEFAULT 25
)
RETURNS TABLE (
  id uuid,
  email text,
  full_name text,
  avatar text,
  role public.user_role,
  account_status public.account_status,
  university_name text,
  points integer,
  uploads integer,
  downloads integer,
  verified boolean,
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
  safe_size integer := least(greatest(coalesce(page_size, 25), 1), 50);
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT
      profile.id,
      auth_user.email::text,
      profile.full_name,
      profile.avatar,
      profile.role,
      profile.account_status,
      university.name AS university_name,
      profile.points,
      profile.uploads,
      profile.downloads,
      profile.verified,
      profile.created_at
    FROM public.profiles AS profile
    JOIN auth.users AS auth_user ON auth_user.id = profile.id
    LEFT JOIN public.universities AS university ON university.id = profile.university_id
    WHERE normalized_query = ''
       OR lower(profile.full_name) LIKE '%' || normalized_query || '%'
       OR lower(coalesce(auth_user.email, '')) LIKE '%' || normalized_query || '%'
       OR lower(coalesce(university.name, '')) LIKE '%' || normalized_query || '%'
  ),
  counted AS (
    SELECT matched.*, count(*) OVER() AS result_total FROM matched
  )
  SELECT
    counted.id, counted.email, counted.full_name, counted.avatar, counted.role,
    counted.account_status, counted.university_name, counted.points,
    counted.uploads, counted.downloads, counted.verified, counted.created_at,
    counted.result_total
  FROM counted
  ORDER BY counted.created_at DESC, counted.id
  OFFSET (safe_page - 1) * safe_size
  LIMIT safe_size;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_change_user_role(
  target_user_id uuid,
  new_role public.user_role,
  operation_request_id text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.profiles;
  after_row public.profiles;
  active_admins integer;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(832746291);
  SELECT * INTO before_row FROM public.profiles WHERE id = target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User profile not found.' USING ERRCODE = 'P0002'; END IF;

  IF before_row.role = 'admin'::public.user_role
     AND before_row.account_status = 'active'::public.account_status
     AND new_role <> 'admin'::public.user_role THEN
    SELECT count(*) INTO active_admins FROM public.profiles
    WHERE role = 'admin'::public.user_role AND account_status = 'active'::public.account_status;
    IF active_admins <= 1 THEN
      RAISE EXCEPTION 'The last active administrator cannot be demoted.' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.profiles SET role = new_role WHERE id = target_user_id RETURNING * INTO after_row;
  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), 'user.role_change', 'profile', target_user_id, operation_request_id, to_jsonb(before_row), to_jsonb(after_row));
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_account_status(
  target_user_id uuid,
  new_status public.account_status,
  reason text,
  operation_request_id text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.profiles;
  after_row public.profiles;
  active_admins integer;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501';
  END IF;
  IF new_status <> 'active'::public.account_status AND char_length(btrim(reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A suspension or deletion reason is required.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(832746291);
  SELECT * INTO before_row FROM public.profiles WHERE id = target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User profile not found.' USING ERRCODE = 'P0002'; END IF;

  IF before_row.role = 'admin'::public.user_role
     AND before_row.account_status = 'active'::public.account_status
     AND new_status <> 'active'::public.account_status THEN
    SELECT count(*) INTO active_admins FROM public.profiles
    WHERE role = 'admin'::public.user_role AND account_status = 'active'::public.account_status;
    IF active_admins <= 1 THEN
      RAISE EXCEPTION 'The last active administrator cannot be suspended or deleted.' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.profiles
  SET account_status = new_status,
      suspended_at = CASE WHEN new_status = 'suspended'::public.account_status THEN now() ELSE NULL END,
      suspension_reason = CASE WHEN new_status = 'active'::public.account_status THEN NULL ELSE btrim(reason) END
  WHERE id = target_user_id
  RETURNING * INTO after_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, after_data, details)
  VALUES ((SELECT auth.uid()), 'user.account_status', 'profile', target_user_id, operation_request_id, to_jsonb(before_row), to_jsonb(after_row), jsonb_build_object('reason', reason));
  RETURN after_row;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_users(text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_change_user_role(uuid, public.user_role, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_account_status(uuid, public.account_status, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_user_role(uuid, public.user_role, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_account_status(uuid, public.account_status, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_record_cleanup_result(
  cleanup_job_id uuid,
  succeeded boolean,
  error_code text DEFAULT NULL,
  operation_request_id text DEFAULT NULL
)
RETURNS public.storage_cleanup_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.storage_cleanup_jobs;
  after_row public.storage_cleanup_jobs;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO before_row FROM public.storage_cleanup_jobs WHERE id = cleanup_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup job not found.' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.storage_cleanup_jobs
  SET status = CASE WHEN succeeded THEN 'completed'::public.cleanup_job_status ELSE 'failed'::public.cleanup_job_status END,
      attempts = attempts + 1,
      last_error_code = CASE WHEN succeeded THEN NULL ELSE left(coalesce(error_code, 'provider_error'), 100) END,
      next_attempt_at = CASE WHEN succeeded THEN next_attempt_at ELSE now() + make_interval(secs => least(3600, (2 ^ least(attempts + 1, 10)) * 30)) END,
      completed_at = CASE WHEN succeeded THEN now() ELSE NULL END
  WHERE id = cleanup_job_id
  RETURNING * INTO after_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), CASE WHEN succeeded THEN 'cleanup.complete' ELSE 'cleanup.failed' END, 'storage_cleanup_job', cleanup_job_id, operation_request_id, to_jsonb(before_row), to_jsonb(after_row));
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_retry_ai_job(
  ai_job_id uuid,
  operation_request_id text DEFAULT NULL
)
RETURNS public.ai_processing_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.ai_processing_jobs;
  after_row public.ai_processing_jobs;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO before_row FROM public.ai_processing_jobs WHERE id = ai_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI job not found.' USING ERRCODE = 'P0002'; END IF;
  IF before_row.attempts >= before_row.max_attempts THEN RAISE EXCEPTION 'AI job has reached its retry limit.' USING ERRCODE = '23514'; END IF;

  UPDATE public.ai_processing_jobs
  SET status = 'queued'::public.ai_processing_status,
      next_attempt_at = now(), locked_at = NULL, locked_by = NULL, last_error_code = NULL
  WHERE id = ai_job_id
  RETURNING * INTO after_row;
  UPDATE public.resources
  SET ai_status = 'queued'::public.ai_processing_status, ai_error_code = NULL, ai_updated_at = now()
  WHERE id = after_row.resource_id;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), 'ai.retry', 'ai_processing_job', ai_job_id, operation_request_id, to_jsonb(before_row), to_jsonb(after_row));
  RETURN after_row;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_record_cleanup_result(uuid, boolean, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_retry_ai_job(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_cleanup_result(uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_retry_ai_job(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Bounded, visibility-aware search. RLS remains the row security boundary.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.search_resources_v2(
  text, uuid, uuid, uuid, text, text, integer, integer
);

CREATE FUNCTION public.search_resources_v2(
  query_text text DEFAULT '',
  university_filter uuid DEFAULT NULL,
  course_filter uuid DEFAULT NULL,
  category_filter uuid DEFAULT NULL,
  file_type_filter text DEFAULT NULL,
  sort_by text DEFAULT 'trending',
  page_number integer DEFAULT 1,
  page_size integer DEFAULT 18
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  university_id uuid,
  university_name text,
  university_short text,
  course_id uuid,
  course_code text,
  course_title text,
  category_id uuid,
  category_name text,
  department text,
  semester text,
  subject text,
  file_type text,
  file_size text,
  size_bytes bigint,
  pages integer,
  uploader_name text,
  uploader_avatar text,
  uploader_verified boolean,
  rating numeric,
  rating_count integer,
  downloads integer,
  views integer,
  bookmarks integer,
  tags text[],
  ai_summary text,
  ai_topics text[],
  ai_status public.ai_processing_status,
  featured boolean,
  trending boolean,
  premium boolean,
  created_at timestamptz,
  total_count bigint,
  match_score double precision
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  normalized_query text := lower(btrim(coalesce(query_text, '')));
  normalized_code_query text := public.normalize_course_code(coalesce(query_text, ''));
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 18), 1), 48);
  safe_sort text := lower(coalesce(sort_by, 'trending'));
BEGIN
  IF safe_sort NOT IN ('trending', 'newest', 'downloads', 'rating') THEN
    RAISE EXCEPTION 'Unsupported sort option.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT
      resource.id,
      resource.title,
      resource.description,
      resource.university_id,
      university.name AS university_name,
      university.short AS university_short,
      resource.course_id,
      coalesce(course.code, resource.course_code) AS course_code,
      course.title AS course_title,
      resource.category_id,
      category.name AS category_name,
      resource.department,
      resource.semester,
      resource.subject,
      resource.file_type,
      resource.file_size,
      resource.size_bytes,
      resource.pages,
      coalesce(profile.full_name, 'StudyDock contributor') AS uploader_name,
      coalesce(profile.avatar, 'SD') AS uploader_avatar,
      coalesce(profile.verified, false) AS uploader_verified,
      resource.rating,
      resource.rating_count,
      resource.downloads,
      resource.views,
      resource.bookmarks,
      resource.tags,
      resource.ai_summary,
      resource.ai_topics,
      resource.ai_status,
      resource.featured,
      resource.trending,
      resource.premium,
      resource.created_at,
      CASE
        WHEN normalized_query = '' THEN 1.0
        ELSE
          CASE WHEN coalesce(course.normalized_code, '') = normalized_code_query THEN 100.0 ELSE 0.0 END
          + CASE WHEN lower(resource.title) = normalized_query THEN 80.0 ELSE 0.0 END
          + ts_rank_cd(
              to_tsvector(
                'simple'::regconfig,
                coalesce(resource.title, '') || ' ' ||
                coalesce(resource.description, '') || ' ' ||
                coalesce(resource.subject, '') || ' ' ||
                coalesce(course.code, '') || ' ' ||
                coalesce(course.title, '') || ' ' ||
                coalesce(university.name, '') || ' ' ||
                coalesce(array_to_string(resource.tags, ' '), '') || ' ' ||
                coalesce(array_to_string(resource.ai_topics, ' '), '')
              ),
              plainto_tsquery('simple'::regconfig, normalized_query)
            ) * 30.0
          -- similarity() comes from pg_trgm and this function pins
          -- search_path to '', so it must be schema-qualified.
          + public.similarity(lower(coalesce(resource.title, '')), normalized_query) * 12.0
          + public.similarity(lower(coalesce(course.code, '')), normalized_query) * 15.0
          + public.similarity(lower(coalesce(course.title, '')), normalized_query) * 8.0
          + public.similarity(lower(coalesce(university.name, '')), normalized_query) * 5.0
      END::double precision AS score
    FROM public.resources AS resource
    LEFT JOIN public.universities AS university ON university.id = resource.university_id
    LEFT JOIN public.courses AS course ON course.id = resource.course_id
    LEFT JOIN public.categories AS category ON category.id = resource.category_id
    LEFT JOIN public.profiles AS profile ON profile.id = resource.uploader_id
    WHERE
      (university_filter IS NULL OR resource.university_id = university_filter)
      AND (course_filter IS NULL OR resource.course_id = course_filter)
      AND (category_filter IS NULL OR resource.category_id = category_filter)
      AND (file_type_filter IS NULL OR resource.file_type = lower(file_type_filter))
      AND (
        normalized_query = ''
        OR lower(resource.title) LIKE '%' || normalized_query || '%'
        OR lower(coalesce(resource.description, '')) LIKE '%' || normalized_query || '%'
        OR lower(coalesce(resource.subject, '')) LIKE '%' || normalized_query || '%'
        OR lower(coalesce(course.code, resource.course_code, '')) LIKE '%' || normalized_query || '%'
        OR lower(coalesce(course.title, '')) LIKE '%' || normalized_query || '%'
        OR lower(coalesce(university.name, '')) LIKE '%' || normalized_query || '%'
        OR EXISTS (
          SELECT 1 FROM unnest(resource.tags || coalesce(resource.ai_topics, '{}'::text[])) AS term
          WHERE lower(term) LIKE '%' || normalized_query || '%'
        )
        OR public.similarity(lower(coalesce(resource.title, '')), normalized_query) >= 0.2
        OR public.similarity(lower(coalesce(course.code, '')), normalized_query) >= 0.25
      )
  ),
  counted AS (
    SELECT matched.*, count(*) OVER() AS result_total
    FROM matched
  )
  SELECT
    counted.id,
    counted.title,
    counted.description,
    counted.university_id,
    counted.university_name,
    counted.university_short,
    counted.course_id,
    counted.course_code,
    counted.course_title,
    counted.category_id,
    counted.category_name,
    counted.department,
    counted.semester,
    counted.subject,
    counted.file_type,
    counted.file_size,
    counted.size_bytes,
    counted.pages,
    counted.uploader_name,
    counted.uploader_avatar,
    counted.uploader_verified,
    counted.rating,
    counted.rating_count,
    counted.downloads,
    counted.views,
    counted.bookmarks,
    counted.tags,
    counted.ai_summary,
    counted.ai_topics,
    counted.ai_status,
    counted.featured,
    counted.trending,
    counted.premium,
    counted.created_at,
    counted.result_total,
    counted.score
  FROM counted
  ORDER BY
    CASE WHEN normalized_query <> '' THEN counted.score END DESC,
    CASE WHEN safe_sort = 'trending' THEN counted.trending::integer END DESC,
    CASE WHEN safe_sort = 'trending' THEN counted.downloads END DESC,
    CASE WHEN safe_sort = 'downloads' THEN counted.downloads END DESC,
    CASE WHEN safe_sort = 'rating' THEN counted.rating END DESC,
    counted.created_at DESC,
    counted.id DESC
  OFFSET (safe_page - 1) * safe_size
  LIMIT safe_size;
END;
$$;

REVOKE ALL ON FUNCTION public.search_resources_v2(text, uuid, uuid, uuid, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_resources_v2(text, uuid, uuid, uuid, text, text, integer, integer)
  TO anon, authenticated;

-- The old unbounded RPC must not remain callable after v2 is available.
REVOKE ALL ON FUNCTION public.search_resources_intelligent(text, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_universities_v2(
  query_text text DEFAULT '',
  page_number integer DEFAULT 1,
  page_size integer DEFAULT 24
)
RETURNS TABLE (
  id uuid,
  name text,
  short text,
  country text,
  color text,
  departments_count integer,
  resource_count bigint,
  contributor_count bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  normalized_query text := public.normalize_catalog_name(coalesce(query_text, ''));
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 24), 1), 48);
BEGIN
  RETURN QUERY
  WITH matched AS (
    SELECT
      university.id,
      university.name,
      university.short,
      university.country,
      university.color,
      university.departments_count,
      (SELECT count(*) FROM public.resources AS resource WHERE resource.university_id = university.id) AS resource_count,
      (SELECT count(*) FROM public.profiles AS profile WHERE profile.university_id = university.id) AS contributor_count
    FROM public.universities AS university
    WHERE normalized_query = ''
       OR university.normalized_name LIKE '%' || normalized_query || '%'
       OR lower(university.short) LIKE '%' || normalized_query || '%'
       OR lower(university.country) LIKE '%' || normalized_query || '%'
  ),
  counted AS (
    SELECT matched.*, count(*) OVER() AS result_total
    FROM matched
  )
  SELECT
    counted.id, counted.name, counted.short, counted.country, counted.color,
    counted.departments_count, counted.resource_count, counted.contributor_count,
    counted.result_total
  FROM counted
  ORDER BY counted.name, counted.id
  OFFSET (safe_page - 1) * safe_size
  LIMIT safe_size;
END;
$$;

REVOKE ALL ON FUNCTION public.list_universities_v2(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_universities_v2(text, integer, integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_categories_v2()
RETURNS TABLE (
  id uuid,
  name text,
  icon text,
  description text,
  resource_count bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    category.id,
    category.name,
    category.icon,
    category.description,
    (SELECT count(*) FROM public.resources AS resource WHERE resource.category_id = category.id)
  FROM public.categories AS category
  ORDER BY category.name, category.id;
$$;

CREATE OR REPLACE FUNCTION public.public_platform_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'resources', (SELECT count(*) FROM public.resources),
    'students', (SELECT count(*) FROM public.profiles),
    'universities', (SELECT count(*) FROM public.universities),
    'downloads', (SELECT coalesce(sum(downloads), 0) FROM public.resources)
  );
$$;

REVOKE ALL ON FUNCTION public.list_categories_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_platform_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_categories_v2() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_platform_stats() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Service-role-only asynchronous PDF analysis worker contract
-- ---------------------------------------------------------------------------

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS ai_reading_time_minutes integer
    CHECK (ai_reading_time_minutes IS NULL OR ai_reading_time_minutes BETWEEN 1 AND 10000);

ALTER TABLE public.ai_processing_jobs
  ADD COLUMN IF NOT EXISTS locked_by uuid;

CREATE OR REPLACE FUNCTION public.claim_ai_processing_job(p_worker_id uuid)
RETURNS TABLE (
  job_id uuid,
  resource_id uuid,
  storage_key text,
  resource_title text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL THEN
    RAISE EXCEPTION 'Worker identity is required.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM public.ai_processing_jobs AS job
    JOIN public.resources AS resource ON resource.id = job.resource_id
    WHERE resource.storage_provider = 'r2'
      AND resource.storage_key IS NOT NULL
      AND resource.mime_type = 'application/pdf'
      AND job.attempts < job.max_attempts
      AND (
        (job.status IN ('queued'::public.ai_processing_status, 'failed'::public.ai_processing_status)
          AND job.next_attempt_at <= now())
        OR (job.status = 'processing'::public.ai_processing_status
          AND job.locked_at < now() - interval '15 minutes')
      )
    ORDER BY job.next_attempt_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE public.ai_processing_jobs AS job
    SET status = 'processing'::public.ai_processing_status,
        attempts = job.attempts + 1,
        locked_at = now(),
        locked_by = p_worker_id,
        last_error_code = NULL
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job.resource_id
  ),
  marked AS (
    UPDATE public.resources AS resource
    SET ai_status = 'processing'::public.ai_processing_status,
        ai_error_code = NULL,
        ai_updated_at = now()
    FROM claimed
    WHERE resource.id = claimed.resource_id
    RETURNING resource.id, resource.storage_key, resource.title
  )
  SELECT claimed.id, claimed.resource_id, marked.storage_key, marked.title
  FROM claimed
  JOIN marked ON marked.id = claimed.resource_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_ai_processing_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_summary text,
  p_topics text[],
  p_tags text[],
  p_reading_time_minutes integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_resource_id uuid;
BEGIN
  IF char_length(btrim(coalesce(p_summary, ''))) NOT BETWEEN 1 AND 3000
     OR p_reading_time_minutes NOT BETWEEN 1 AND 10000
     OR coalesce(array_length(p_topics, 1), 0) > 12
     OR coalesce(array_length(p_tags, 1), 0) > 12 THEN
    RAISE EXCEPTION 'Invalid AI result.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ai_processing_jobs
  SET status = 'completed'::public.ai_processing_status,
      completed_at = now(),
      locked_at = NULL,
      locked_by = NULL,
      last_error_code = NULL
  WHERE id = p_job_id
    AND status = 'processing'::public.ai_processing_status
    AND locked_by = p_worker_id
  RETURNING resource_id INTO target_resource_id;

  IF target_resource_id IS NULL THEN
    RAISE EXCEPTION 'AI job lock is invalid.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.resources AS resource
  SET ai_summary = btrim(p_summary),
      ai_topics = ARRAY(
        SELECT DISTINCT btrim(topic)
        FROM unnest(coalesce(p_topics, '{}'::text[])) AS topic
        WHERE char_length(btrim(topic)) BETWEEN 1 AND 100
        LIMIT 12
      ),
      tags = ARRAY(
        SELECT DISTINCT lower(btrim(tag))
        FROM unnest(coalesce(resource.tags, '{}'::text[]) || coalesce(p_tags, '{}'::text[])) AS tag
        WHERE char_length(btrim(tag)) BETWEEN 1 AND 50
        LIMIT 30
      ),
      ai_reading_time_minutes = p_reading_time_minutes,
      ai_status = 'completed'::public.ai_processing_status,
      ai_error_code = NULL,
      ai_updated_at = now()
  WHERE id = target_resource_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_ai_processing_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_error_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_resource_id uuid;
  safe_error_code text := upper(btrim(coalesce(p_error_code, 'AI_PROCESSING_FAILED')));
BEGIN
  IF safe_error_code !~ '^[A-Z0-9_]{3,80}$' THEN safe_error_code := 'AI_PROCESSING_FAILED'; END IF;

  UPDATE public.ai_processing_jobs
  SET status = 'failed'::public.ai_processing_status,
      next_attempt_at = CASE attempts
        WHEN 1 THEN now() + interval '5 minutes'
        WHEN 2 THEN now() + interval '30 minutes'
        ELSE now() + interval '2 hours'
      END,
      locked_at = NULL,
      locked_by = NULL,
      last_error_code = safe_error_code
  WHERE id = p_job_id
    AND status = 'processing'::public.ai_processing_status
    AND locked_by = p_worker_id
  RETURNING resource_id INTO target_resource_id;

  IF target_resource_id IS NULL THEN
    RAISE EXCEPTION 'AI job lock is invalid.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.resources
  SET ai_status = 'failed'::public.ai_processing_status,
      ai_error_code = safe_error_code,
      ai_updated_at = now()
  WHERE id = target_resource_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_processing_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_ai_processing_job(uuid, uuid, text, text[], text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_ai_processing_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_processing_job(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_processing_job(uuid, uuid, text, text[], text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_ai_processing_job(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Audited proposal rejection and permanent resource deletion workflow
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_university_proposal(
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
BEGIN
  IF NOT (SELECT public.is_admin()) THEN RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(coalesce(reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'A rejection reason is required.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO before_row FROM public.universities WHERE id = university_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'University proposal not found.' USING ERRCODE = 'P0002'; END IF;
  IF before_row.status <> 'custom_pending'::public.record_status THEN RAISE EXCEPTION 'Only pending proposals can be rejected.' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.resources WHERE university_id = before_row.id)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE university_id = before_row.id) THEN
    RAISE EXCEPTION 'This proposal is in use. Merge it into an official university instead.' USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.courses AS course
  WHERE course.university_id = before_row.id
    AND course.status = 'custom_pending'::public.record_status
    AND NOT EXISTS (SELECT 1 FROM public.resources WHERE course_id = course.id);
  IF EXISTS (SELECT 1 FROM public.courses WHERE university_id = before_row.id) THEN
    RAISE EXCEPTION 'This proposal has courses in use. Merge it instead.' USING ERRCODE = '23503';
  END IF;
  DELETE FROM public.universities WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, details)
  VALUES ((SELECT auth.uid()), 'university.reject', 'university', before_row.id, operation_request_id, to_jsonb(before_row), jsonb_build_object('reason', btrim(reason)));
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_course_proposal(
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
BEGIN
  IF NOT (SELECT public.is_admin()) THEN RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(coalesce(reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'A rejection reason is required.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO before_row FROM public.courses WHERE id = course_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course proposal not found.' USING ERRCODE = 'P0002'; END IF;
  IF before_row.status <> 'custom_pending'::public.record_status THEN RAISE EXCEPTION 'Only pending proposals can be rejected.' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.resources WHERE course_id = before_row.id) THEN
    RAISE EXCEPTION 'This proposal is in use. Merge it into an official course instead.' USING ERRCODE = '23503';
  END IF;
  DELETE FROM public.courses WHERE id = before_row.id;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, details)
  VALUES ((SELECT auth.uid()), 'course.reject', 'course', before_row.id, operation_request_id, to_jsonb(before_row), jsonb_build_object('reason', btrim(reason)));
END;
$$;

ALTER TABLE public.storage_cleanup_jobs
  ADD COLUMN IF NOT EXISTS resource_id uuid REFERENCES public.resources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delete_resource_on_success boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.request_resource_permanent_deletion(
  resource_id uuid,
  reason text,
  operation_request_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.resources;
  cleanup_job_id uuid;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(coalesce(reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'A deletion reason is required.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO before_row FROM public.resources WHERE id = resource_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.resources
  SET status = 'removed'::public.resource_status,
      featured = false,
      moderation_reason = btrim(reason),
      moderated_by = (SELECT auth.uid()),
      moderated_at = now()
  WHERE id = before_row.id;

  IF before_row.storage_provider = 'r2' AND before_row.storage_key IS NOT NULL THEN
    SELECT id INTO cleanup_job_id
    FROM public.storage_cleanup_jobs
    WHERE storage_provider = 'r2'
      AND storage_key = before_row.storage_key
      AND status IN ('pending'::public.cleanup_job_status, 'failed'::public.cleanup_job_status)
    ORDER BY (status = 'pending'::public.cleanup_job_status) DESC, created_at DESC LIMIT 1
    FOR UPDATE;

    IF cleanup_job_id IS NULL THEN
      INSERT INTO public.storage_cleanup_jobs (
        storage_provider, storage_key, reason, resource_id, delete_resource_on_success
      ) VALUES (
        'r2', before_row.storage_key, 'permanent_resource_deletion', before_row.id, true
      ) RETURNING id INTO cleanup_job_id;
    ELSE
      UPDATE public.storage_cleanup_jobs
      SET resource_id = before_row.id,
          delete_resource_on_success = true,
          reason = 'permanent_resource_deletion',
          status = 'pending'::public.cleanup_job_status,
          next_attempt_at = now(),
          last_error_code = NULL
      WHERE id = cleanup_job_id;
    END IF;
  ELSE
    DELETE FROM public.resources WHERE id = before_row.id;
  END IF;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, details)
  VALUES ((SELECT auth.uid()), 'resource.delete.requested', 'resource', before_row.id, operation_request_id, to_jsonb(before_row), jsonb_build_object('reason', btrim(reason), 'cleanupJobId', cleanup_job_id));
  RETURN cleanup_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_record_cleanup_result(
  cleanup_job_id uuid,
  succeeded boolean,
  error_code text DEFAULT NULL,
  operation_request_id text DEFAULT NULL
)
RETURNS public.storage_cleanup_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_row public.storage_cleanup_jobs;
  after_row public.storage_cleanup_jobs;
  resource_before public.resources;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN RAISE EXCEPTION 'Administrator access required.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO before_row FROM public.storage_cleanup_jobs WHERE id = cleanup_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup job not found.' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.storage_cleanup_jobs
  SET status = CASE WHEN succeeded THEN 'completed'::public.cleanup_job_status ELSE 'failed'::public.cleanup_job_status END,
      attempts = attempts + 1,
      last_error_code = CASE WHEN succeeded THEN NULL ELSE left(coalesce(error_code, 'provider_error'), 100) END,
      next_attempt_at = CASE WHEN succeeded THEN next_attempt_at ELSE now() + make_interval(secs => least(3600, (2 ^ least(attempts + 1, 10)) * 30)::integer) END,
      completed_at = CASE WHEN succeeded THEN now() ELSE NULL END
  WHERE id = cleanup_job_id
  RETURNING * INTO after_row;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, after_data)
  VALUES ((SELECT auth.uid()), CASE WHEN succeeded THEN 'cleanup.complete' ELSE 'cleanup.failed' END, 'storage_cleanup_job', cleanup_job_id, operation_request_id, to_jsonb(before_row), to_jsonb(after_row));

  IF succeeded AND after_row.delete_resource_on_success AND after_row.resource_id IS NOT NULL THEN
    SELECT * INTO resource_before FROM public.resources WHERE id = after_row.resource_id FOR UPDATE;
    IF FOUND THEN
      DELETE FROM public.resources WHERE id = resource_before.id;
      INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, request_id, before_data, details)
      VALUES ((SELECT auth.uid()), 'resource.delete.completed', 'resource', resource_before.id, operation_request_id, to_jsonb(resource_before), jsonb_build_object('cleanupJobId', cleanup_job_id));
    END IF;
  END IF;
  RETURN after_row;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_university_proposal(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_course_proposal(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_resource_permanent_deletion(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_university_proposal(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_course_proposal(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_resource_permanent_deletion(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Combined account and privacy-preserving IP rate limits
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.api_ip_rate_limit_buckets (
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (ip_hash, action, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_api_ip_rate_limit_buckets_expiry
  ON public.api_ip_rate_limit_buckets(expires_at);

ALTER TABLE public.api_ip_rate_limit_buckets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_api_rate_limit_v2(
  p_action text,
  p_ip_hash text
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  normalized_action text := lower(btrim(p_action));
  account_limit integer;
  ip_limit integer;
  window_seconds integer;
  bucket_start timestamptz;
  account_count integer;
  ip_count integer;
BEGIN
  IF caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501'; END IF;
  IF p_ip_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid IP hash.' USING ERRCODE = '22023'; END IF;

  SELECT limits.account_limit, limits.ip_limit, limits.window_seconds
  INTO account_limit, ip_limit, window_seconds
  FROM (VALUES
    ('upload.presign', 10, 40, 60),
    ('upload.finalize', 10, 40, 60),
    ('resource.download', 60, 180, 60),
    ('ai.summarize', 10, 30, 60)
  ) AS limits(action, account_limit, ip_limit, window_seconds)
  WHERE limits.action = normalized_action;

  IF account_limit IS NULL THEN RAISE EXCEPTION 'Unknown rate-limit action.' USING ERRCODE = '22023'; END IF;
  bucket_start := to_timestamp(floor(extract(epoch FROM now()) / window_seconds) * window_seconds);

  INSERT INTO public.api_rate_limit_buckets (actor_id, action, window_started_at, request_count, expires_at)
  VALUES (caller_id, normalized_action, bucket_start, 1, bucket_start + make_interval(secs => window_seconds * 2))
  ON CONFLICT (actor_id, action, window_started_at)
  DO UPDATE SET request_count = public.api_rate_limit_buckets.request_count + 1
  RETURNING request_count INTO account_count;

  INSERT INTO public.api_ip_rate_limit_buckets (ip_hash, action, window_started_at, request_count, expires_at)
  VALUES (p_ip_hash, normalized_action, bucket_start, 1, bucket_start + make_interval(secs => window_seconds * 2))
  ON CONFLICT (ip_hash, action, window_started_at)
  DO UPDATE SET request_count = public.api_ip_rate_limit_buckets.request_count + 1
  RETURNING request_count INTO ip_count;

  RETURN QUERY SELECT
    account_count <= account_limit AND ip_count <= ip_limit,
    greatest(1, ceil(extract(epoch FROM (bucket_start + make_interval(secs => window_seconds) - now())))::integer),
    greatest(0, least(account_limit - account_count, ip_limit - ip_count));
END;
$$;

REVOKE ALL ON TABLE public.api_ip_rate_limit_buckets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_api_rate_limit_v2(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_api_rate_limit_v2(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Delayed, retryable account erasure after the logical deleted state
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE TYPE public.erasure_job_status AS ENUM (
    'scheduled', 'processing', 'completed', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS public.account_erasure_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL UNIQUE,
  status public.erasure_job_status NOT NULL DEFAULT 'scheduled',
  scheduled_for timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  locked_at timestamptz,
  locked_by uuid,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_erasure_jobs_work
  ON public.account_erasure_jobs(status, scheduled_for, id)
  WHERE status IN ('scheduled'::public.erasure_job_status, 'failed'::public.erasure_job_status);

ALTER TABLE public.account_erasure_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.account_erasure_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.account_erasure_jobs TO authenticated;

DROP POLICY IF EXISTS "admin_read_account_erasure_jobs" ON public.account_erasure_jobs;
CREATE POLICY "admin_read_account_erasure_jobs"
ON public.account_erasure_jobs FOR SELECT TO authenticated
USING ((SELECT public.is_admin()));

DROP TRIGGER IF EXISTS account_erasure_jobs_set_updated_at ON public.account_erasure_jobs;
CREATE TRIGGER account_erasure_jobs_set_updated_at
BEFORE UPDATE ON public.account_erasure_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.schedule_account_erasure_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.account_status = 'deleted'::public.account_status
     AND OLD.account_status <> 'deleted'::public.account_status THEN
    INSERT INTO public.account_erasure_jobs (target_user_id, status, scheduled_for)
    VALUES (NEW.id, 'scheduled'::public.erasure_job_status, now() + interval '30 days')
    ON CONFLICT (target_user_id) DO UPDATE
    SET status = 'scheduled'::public.erasure_job_status,
        scheduled_for = now() + interval '30 days',
        attempts = 0,
        locked_at = NULL,
        locked_by = NULL,
        completed_at = NULL,
        last_error_code = NULL;
  ELSIF NEW.account_status = 'active'::public.account_status
        AND OLD.account_status = 'deleted'::public.account_status THEN
    UPDATE public.account_erasure_jobs
    SET status = 'cancelled'::public.erasure_job_status,
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = NULL
    WHERE target_user_id = NEW.id
      AND status <> 'completed'::public.erasure_job_status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_schedule_account_erasure ON public.profiles;
CREATE TRIGGER profiles_schedule_account_erasure
AFTER UPDATE OF account_status ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.schedule_account_erasure_from_profile();

CREATE OR REPLACE FUNCTION public.claim_account_erasure_job(p_worker_id uuid)
RETURNS TABLE (job_id uuid, target_user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL THEN RAISE EXCEPTION 'Worker identity is required.' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM public.account_erasure_jobs AS job
    WHERE job.attempts < job.max_attempts
      AND (
        (job.status IN ('scheduled'::public.erasure_job_status, 'failed'::public.erasure_job_status)
          AND job.scheduled_for <= now())
        OR (job.status = 'processing'::public.erasure_job_status
          AND job.locked_at < now() - interval '30 minutes')
      )
    ORDER BY job.scheduled_for, job.created_at, job.id
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE public.account_erasure_jobs AS job
  SET status = 'processing'::public.erasure_job_status,
      attempts = job.attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      last_error_code = NULL
  FROM candidate
  WHERE job.id = candidate.id
  RETURNING job.id, job.target_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_account_erasure_job(p_job_id uuid, p_worker_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.account_erasure_jobs
  SET status = 'completed'::public.erasure_job_status,
      completed_at = now(), locked_at = NULL, locked_by = NULL, last_error_code = NULL
  WHERE id = p_job_id AND status = 'processing'::public.erasure_job_status AND locked_by = p_worker_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Erasure job lock is invalid.' USING ERRCODE = '42501'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_account_erasure_job(
  p_job_id uuid, p_worker_id uuid, p_error_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  safe_code text := upper(btrim(coalesce(p_error_code, 'ACCOUNT_ERASURE_FAILED')));
BEGIN
  IF safe_code !~ '^[A-Z0-9_]{3,80}$' THEN safe_code := 'ACCOUNT_ERASURE_FAILED'; END IF;
  UPDATE public.account_erasure_jobs
  SET status = 'failed'::public.erasure_job_status,
      attempts = CASE WHEN safe_code = 'ERASURE_MORE_RESOURCES_PENDING' THEN greatest(attempts - 1, 0) ELSE attempts END,
      scheduled_for = now() + CASE
        WHEN safe_code = 'ERASURE_MORE_RESOURCES_PENDING' THEN interval '1 minute'
        WHEN attempts = 1 THEN interval '30 minutes'
        WHEN attempts = 2 THEN interval '2 hours'
        ELSE interval '1 day'
      END,
      locked_at = NULL, locked_by = NULL, last_error_code = safe_code
  WHERE id = p_job_id AND status = 'processing'::public.erasure_job_status AND locked_by = p_worker_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Erasure job lock is invalid.' USING ERRCODE = '42501'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_account_erasure_from_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_account_erasure_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_account_erasure_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_account_erasure_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_erasure_job(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_account_erasure_job(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_account_erasure_job(uuid, uuid, text) TO service_role;
