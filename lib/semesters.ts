/**
 * Semester options for the upload form.
 *
 * This used to be a free-text box with the placeholder "e.g. Fall 2024", which
 * produced "Fall24", "fall 2024", "Autumn 2024" and "F24" for the same term.
 * Offering a fixed list removes the spelling problem and makes the values
 * comparable across uploads.
 *
 * The string format stays "<Term> <YYYY>" so rows written before this change
 * still line up with the generated options.
 */

export const SEMESTER_TERMS = ['Spring', 'Summer', 'Fall'] as const;
export type SemesterTerm = (typeof SEMESTER_TERMS)[number];

export type SemesterOption = {
  value: string;
  term: SemesterTerm;
  year: number;
};

/** How many years either side of the current one to offer. */
const YEAR_RADIUS = 2;

/**
 * Term boundaries follow the tri-semester calendar these institutions use:
 * Jan-Apr Spring, May-Aug Summer, Sep-Dec Fall.
 */
export function termForMonth(monthIndex: number): SemesterTerm {
  if (monthIndex <= 3) return 'Spring';
  if (monthIndex <= 7) return 'Summer';
  return 'Fall';
}

/** The semester a given date falls in. `now` is injectable so tests are stable. */
export function currentSemester(now: Date = new Date()): SemesterOption {
  const year = now.getFullYear();
  const term = termForMonth(now.getMonth());
  return { value: `${term} ${year}`, term, year };
}

/**
 * Newest first: the term someone is uploading for is almost always the current
 * one or the one just finished, so those should not require scrolling.
 */
export function semesterOptions(now: Date = new Date()): SemesterOption[] {
  const currentYear = now.getFullYear();
  const options: SemesterOption[] = [];

  for (let year = currentYear + YEAR_RADIUS; year >= currentYear - YEAR_RADIUS; year -= 1) {
    for (let index = SEMESTER_TERMS.length - 1; index >= 0; index -= 1) {
      const term = SEMESTER_TERMS[index];
      options.push({ value: `${term} ${year}`, term, year });
    }
  }

  return options;
}

/** Whether a stored value matches one of the offered options. */
export function isKnownSemester(value: string, now: Date = new Date()): boolean {
  return semesterOptions(now).some((option) => option.value === value);
}
