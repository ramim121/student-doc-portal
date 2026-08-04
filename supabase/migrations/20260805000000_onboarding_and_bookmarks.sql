/*
  Signup onboarding (country + institution) and working bookmarks.

  Two things this has to be careful about:

  1. 20260803130000 revoked blanket SELECT on public.profiles and re-granted a
     fixed column list. A new column is therefore invisible to the API until it
     is added to that grant, so every column added here is granted explicitly.
  2. 20260803120000 did the same for UPDATE. Users must be able to write their
     own onboarding answers, so those three columns are added to the UPDATE
     grant - and only those.

  High schools live in `universities` rather than a parallel table: every
  relationship the app already has (resources, courses, profiles, merges,
  search) points at universities.id, and forking that into two tables would
  double every one of those paths for no gain. The row means "institution";
  institution_type says which kind.
*/

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE TYPE public.institution_type AS ENUM ('university', 'high_school');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Institutions
-- ---------------------------------------------------------------------------

ALTER TABLE public.universities
  ADD COLUMN IF NOT EXISTS institution_type public.institution_type
    NOT NULL DEFAULT 'university';

CREATE INDEX IF NOT EXISTS idx_universities_country_type
  ON public.universities(country, institution_type, name);

-- ---------------------------------------------------------------------------
-- Profile onboarding answers
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS institution_type public.institution_type,
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

-- Existing members already told us where they study by picking a university.
UPDATE public.profiles AS profile
SET country = university.country,
    institution_type = university.institution_type,
    onboarded_at = coalesce(profile.onboarded_at, now())
FROM public.universities AS university
WHERE profile.university_id = university.id
  AND profile.country IS NULL;

-- Without these the new columns simply do not exist as far as PostgREST and
-- the app are concerned. See the note at the top of this file.
GRANT SELECT (country, institution_type, onboarded_at)
  ON public.profiles TO anon, authenticated;

GRANT UPDATE (country, institution_type, onboarded_at)
  ON public.profiles TO authenticated;

-- ---------------------------------------------------------------------------
-- Bookmarks
--
-- resources.bookmarks already existed as a bare counter with nothing writing
-- to it, and the UI kept "saved" in React state that died on navigation. This
-- is the missing ownership table; the counter is maintained by trigger so it
-- cannot drift from the rows.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.resource_bookmarks (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_bookmarks_user
  ON public.resource_bookmarks(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_resource_bookmarks_resource
  ON public.resource_bookmarks(resource_id);

ALTER TABLE public.resource_bookmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_bookmarks" ON public.resource_bookmarks;
CREATE POLICY "select_own_bookmarks"
ON public.resource_bookmarks FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "insert_own_bookmarks" ON public.resource_bookmarks;
CREATE POLICY "insert_own_bookmarks"
ON public.resource_bookmarks FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND (SELECT public.is_active_user())
);

DROP POLICY IF EXISTS "delete_own_bookmarks" ON public.resource_bookmarks;
CREATE POLICY "delete_own_bookmarks"
ON public.resource_bookmarks FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, DELETE ON public.resource_bookmarks TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_resource_bookmark_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.resources
    SET bookmarks = bookmarks + 1
    WHERE id = NEW.resource_id;
    RETURN NEW;
  END IF;

  UPDATE public.resources
  SET bookmarks = greatest(bookmarks - 1, 0)
  WHERE id = OLD.resource_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_resource_bookmark_count() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS resource_bookmarks_sync_count ON public.resource_bookmarks;
CREATE TRIGGER resource_bookmarks_sync_count
AFTER INSERT OR DELETE ON public.resource_bookmarks
FOR EACH ROW EXECUTE FUNCTION public.sync_resource_bookmark_count();

-- Reconcile the counter with reality, in case it was ever written by hand.
UPDATE public.resources AS resource
SET bookmarks = counted.total
FROM (
  SELECT inner_resource.id, count(bookmark.resource_id)::integer AS total
  FROM public.resources AS inner_resource
  LEFT JOIN public.resource_bookmarks AS bookmark
    ON bookmark.resource_id = inner_resource.id
  GROUP BY inner_resource.id
) AS counted
WHERE resource.id = counted.id
  AND resource.bookmarks IS DISTINCT FROM counted.total;

-- ---------------------------------------------------------------------------
-- Onboarding write path
--
-- A SECURITY DEFINER function rather than a direct UPDATE, so that picking an
-- institution cannot be used to point a profile at a pending proposal that the
-- caller does not own.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_country text,
  p_institution_type public.institution_type,
  p_university_id uuid
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  updated_row public.profiles;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.is_active_user()) THEN
    RAISE EXCEPTION 'This account cannot be updated.' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_country, ''))) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'A country is required.' USING ERRCODE = '22023';
  END IF;

  IF p_university_id IS NOT NULL THEN
    PERFORM 1
    FROM public.universities
    WHERE id = p_university_id
      AND (
        status = 'official'::public.record_status
        OR proposed_by = caller_id
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That institution is unavailable.' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.profiles
  SET country = btrim(p_country),
      institution_type = p_institution_type,
      university_id = coalesce(p_university_id, university_id),
      onboarded_at = now()
  WHERE id = caller_id
  RETURNING * INTO updated_row;

  RETURN updated_row;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_onboarding(text, public.institution_type, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, public.institution_type, uuid)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Institution lookup for the onboarding picker and the upload form.
-- Country-scoped, type-scoped, and ordered so the user's own country leads.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_institutions(
  p_country text DEFAULT NULL,
  p_institution_type public.institution_type DEFAULT NULL,
  p_query text DEFAULT '',
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  name text,
  short text,
  country text,
  institution_type public.institution_type,
  resource_count bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    university.id,
    university.name,
    university.short,
    university.country,
    university.institution_type,
    (
      SELECT count(*)
      FROM public.resources AS resource
      WHERE resource.university_id = university.id
        AND resource.status = 'approved'::public.resource_status
    )
  FROM public.universities AS university
  WHERE university.status = 'official'::public.record_status
    AND (p_institution_type IS NULL OR university.institution_type = p_institution_type)
    AND (
      coalesce(btrim(p_query), '') = ''
      OR university.normalized_name LIKE '%' || public.normalize_catalog_name(p_query) || '%'
      OR lower(university.short) LIKE '%' || lower(btrim(p_query)) || '%'
    )
  ORDER BY
    -- the caller's own country first, then by how much material is there
    (university.country IS DISTINCT FROM p_country),
    (
      SELECT count(*)
      FROM public.resources AS resource
      WHERE resource.university_id = university.id
        AND resource.status = 'approved'::public.resource_status
    ) DESC,
    university.name
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

REVOKE ALL ON FUNCTION public.list_institutions(text, public.institution_type, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_institutions(text, public.institution_type, text, integer)
  TO anon, authenticated;

-- Distinct countries that actually have institutions, for the country select.
CREATE OR REPLACE FUNCTION public.list_institution_countries()
RETURNS TABLE (country text, institution_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT university.country, count(*)
  FROM public.universities AS university
  WHERE university.status = 'official'::public.record_status
  GROUP BY university.country
  ORDER BY university.country;
$$;

REVOKE ALL ON FUNCTION public.list_institution_countries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_institution_countries() TO anon, authenticated;
