/**
 * Monogram colours for institution tiles.
 *
 * universities.color holds Tailwind gradient classes, but Tailwind only emits
 * classes it can see in source - and these arrive from the database. Every
 * stored value therefore compiled to nothing, so the tiles rendered with no
 * background at all (computed background-image: none).
 *
 * Two things fix that together: this fixed palette, and the matching safelist
 * in tailwind.config.ts. Anything outside the palette falls back to a gradient
 * that is guaranteed to exist rather than silently rendering blank.
 */

export type MonogramTheme = {
  /** Stored in universities.color. */
  value: string;
  label: string;
};

export const MONOGRAM_THEMES: MonogramTheme[] = [
  { value: 'from-indigo-600 to-blue-700', label: 'Indigo' },
  { value: 'from-blue-700 to-indigo-800', label: 'Deep blue' },
  { value: 'from-emerald-600 to-teal-700', label: 'Emerald' },
  { value: 'from-red-500 to-rose-600', label: 'Red' },
  { value: 'from-orange-500 to-red-600', label: 'Orange' },
  { value: 'from-amber-500 to-orange-600', label: 'Amber' },
  { value: 'from-fuchsia-500 to-purple-600', label: 'Fuchsia' },
  { value: 'from-purple-600 to-indigo-700', label: 'Purple' },
  { value: 'from-cyan-500 to-blue-600', label: 'Cyan' },
  { value: 'from-slate-700 to-slate-900', label: 'Slate' },
];

export const DEFAULT_MONOGRAM = 'from-indigo-600 to-blue-700';

const KNOWN = new Set(MONOGRAM_THEMES.map((theme) => theme.value));

/**
 * The gradient classes for a stored colour, or the default when the stored
 * value is missing or is not one the stylesheet actually contains.
 */
export function monogramGradient(color: string | null | undefined): string {
  const trimmed = (color ?? '').trim();
  return KNOWN.has(trimmed) ? trimmed : DEFAULT_MONOGRAM;
}
