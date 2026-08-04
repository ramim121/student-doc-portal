/*
  Make the seed data in 20260803061612_create_initial_schema.sql genuinely
  idempotent.

  That migration ends with:

    INSERT INTO categories (name, icon, description) VALUES (...)
      ON CONFLICT DO NOTHING;
    INSERT INTO departments (university_id, name) SELECT ...
      ON CONFLICT DO NOTHING;

  Neither table has a unique constraint, so `ON CONFLICT DO NOTHING` never fires
  and every re-run inserts another full copy. `universities` was unaffected
  because `name` is already UNIQUE.

  This migration removes the duplicates that already exist and adds the
  constraints that make those INSERTs behave as intended from now on.
*/

-- ---------------------------------------------------------------------------
-- Categories: keep the oldest row per name, repoint resources, drop the rest.
-- ---------------------------------------------------------------------------

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id
  FROM public.categories
)
UPDATE public.resources AS resource
SET category_id = ranked.keep_id
FROM ranked
WHERE resource.category_id = ranked.id
  AND ranked.id <> ranked.keep_id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY name ORDER BY created_at, id) AS position
  FROM public.categories
)
DELETE FROM public.categories AS category
USING ranked
WHERE category.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_name
  ON public.categories(name);

-- ---------------------------------------------------------------------------
-- Departments: keep the oldest row per (university, name).
-- Nothing references departments by foreign key; resources.department is text.
-- ---------------------------------------------------------------------------

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY university_id, name ORDER BY created_at, id
    ) AS position
  FROM public.departments
)
DELETE FROM public.departments AS department
USING ranked
WHERE department.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_university_name
  ON public.departments(university_id, name);

-- ---------------------------------------------------------------------------
-- Subjects: same exposure. The table is not seeded by the initial migration,
-- but nothing stops a repeated insert, so constrain it too. `department` is
-- nullable and NULLs never collide, so normalize inside the index.
-- ---------------------------------------------------------------------------

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY university_id, coalesce(department, ''), name
      ORDER BY created_at, id
    ) AS position
  FROM public.subjects
)
DELETE FROM public.subjects AS subject
USING ranked
WHERE subject.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subjects_university_department_name
  ON public.subjects(university_id, coalesce(department, ''), name);

-- ---------------------------------------------------------------------------
-- The stored department counter is wrong wherever duplicates were removed.
-- ---------------------------------------------------------------------------

UPDATE public.universities AS university
SET departments_count = (
  SELECT count(*)::integer
  FROM public.departments AS department
  WHERE department.university_id = university.id
)
WHERE departments_count IS DISTINCT FROM (
  SELECT count(*)::integer
  FROM public.departments AS department
  WHERE department.university_id = university.id
);
