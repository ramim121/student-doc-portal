/*
# Enhanced Schema Migration for STUDYDOCK

## Overview
1. Adds RBAC `role` ('user', 'admin') to profiles table.
2. Adds `status` ('official', 'custom_pending') to universities table.
3. Creates `courses` table for university-specific courses and short codes (e.g. ACC-401, FIN-435).
4. Updates `resources` table to link `course_id`, `storage_provider`, `storage_key`, `ai_summary`, and `ai_topics`.
5. Sets up pg_trgm extension and indexes for intelligent multi-field search.
*/

-- Enable pg_trgm extension for fuzzy trigram searching.
-- It must live in `public`: search_resources_v2 pins search_path to '' and
-- calls public.similarity(), so the extension's schema cannot be left to
-- whatever the session search_path happens to be.
DO $$
DECLARE
  trgm_schema text;
BEGIN
  SELECT namespace.nspname
  INTO trgm_schema
  FROM pg_extension AS extension
  JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pg_trgm';

  IF trgm_schema IS NULL THEN
    CREATE EXTENSION pg_trgm WITH SCHEMA public;
  ELSIF trgm_schema <> 'public' THEN
    ALTER EXTENSION pg_trgm SET SCHEMA public;
  END IF;
END
$$;

-- 1. USER ROLE ENUM & PROFILE ENHANCEMENT
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('user', 'admin');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user';

-- 2. UNIVERSITY STATUS ENUM & ENHANCEMENT
DO $$ BEGIN
    CREATE TYPE record_status AS ENUM ('official', 'custom_pending');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE universities ADD COLUMN IF NOT EXISTS status record_status NOT NULL DEFAULT 'official';

-- Trigram index on university names
CREATE INDEX IF NOT EXISTS idx_universities_name_trgm ON universities USING gin (name gin_trgm_ops);

-- 3. COURSES TABLE
CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  code text NOT NULL, -- e.g., ACC-401, FIN-435, CS-229
  title text NOT NULL,
  description text,
  status record_status NOT NULL DEFAULT 'official',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_univ_course_code UNIQUE(university_id, code)
);

CREATE INDEX IF NOT EXISTS idx_courses_university_id ON courses(university_id);
CREATE INDEX IF NOT EXISTS idx_courses_code_trgm ON courses USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_courses_title_trgm ON courses USING gin (title gin_trgm_ops);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_courses" ON courses;
CREATE POLICY "public_read_courses" ON courses FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_insert_courses" ON courses;
CREATE POLICY "authenticated_insert_courses" ON courses FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "admin_manage_courses" ON courses;
CREATE POLICY "admin_manage_courses" ON courses FOR ALL
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- 4. RESOURCES ENHANCEMENT FOR CLOUDFLARE R2 & GEMINI AI
ALTER TABLE resources ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'r2';
ALTER TABLE resources ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS ai_topics text[];

CREATE INDEX IF NOT EXISTS idx_resources_course_id ON resources(course_id);
CREATE INDEX IF NOT EXISTS idx_resources_title_trgm ON resources USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_resources_desc_trgm ON resources USING gin (description gin_trgm_ops);
