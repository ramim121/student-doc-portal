/**
 * Tags are derived, not typed.
 *
 * Free-text tags were a data-quality problem: the same course arrived as
 * "fin435", "FIN 435" and "corporate finance" depending on who uploaded it, so
 * tag search matched almost nothing. Everything a tag is useful for - the
 * institution, the course, the kind of document, the file format - is already
 * captured by other fields, so tags are generated from those instead.
 *
 * Generated server-side in /api/upload/finalize and never accepted from the
 * client, so a caller cannot stuff a resource with unrelated search terms.
 */

export type AutoTagSource = {
  universityShort?: string | null;
  universityName?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  categoryName?: string | null;
  department?: string | null;
  fileType?: string | null;
};

/** Words that only add noise to a tag list. */
const STOP_WORDS = new Set([
  'the', 'of', 'and', 'for', 'in', 'to', 'a', 'an', 'at',
  'university', 'college', 'school', 'institute', 'department',
]);

const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 50;

/** Lowercase, collapse punctuation to single hyphens, trim hyphens. */
export function normalizeTag(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * Significant words from a name, so "East West University" contributes
 * `east-west` rather than three fragments including the word "university".
 */
function phraseTag(value: string): string[] {
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  if (!words.length) return [];
  return [normalizeTag(words.slice(0, 4).join(' '))];
}

export function buildAutoTags(source: AutoTagSource): string[] {
  const candidates: string[] = [];

  // Institution: the short code is what people actually search for.
  if (source.universityShort) candidates.push(normalizeTag(source.universityShort));
  if (source.universityName) candidates.push(...phraseTag(source.universityName));

  // Course: code first, it is the most selective term available.
  if (source.courseCode) candidates.push(normalizeTag(source.courseCode));
  if (source.courseTitle) candidates.push(...phraseTag(source.courseTitle));

  // What kind of document this is, and which department it belongs to.
  if (source.categoryName) candidates.push(normalizeTag(source.categoryName));
  if (source.department) candidates.push(...phraseTag(source.department));

  // Format, so "pdf" and "video" filters work off tags too.
  if (source.fileType) candidates.push(normalizeTag(source.fileType));

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of candidates) {
    if (!tag || tag.length < 2 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}
