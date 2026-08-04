import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentSemester,
  isKnownSemester,
  semesterOptions,
  termForMonth,
} from '../lib/semesters';

// Fixed dates throughout: a clock-dependent test fails silently in January.
const AUGUST = new Date(2026, 7, 5);
const OCTOBER = new Date(2026, 9, 1);
const FEBRUARY = new Date(2026, 1, 14);

test('months map to the tri-semester calendar', () => {
  assert.equal(termForMonth(0), 'Spring'); // January
  assert.equal(termForMonth(3), 'Spring'); // April
  assert.equal(termForMonth(4), 'Summer'); // May
  assert.equal(termForMonth(7), 'Summer'); // August
  assert.equal(termForMonth(8), 'Fall'); // September
  assert.equal(termForMonth(11), 'Fall'); // December
});

test('the current semester follows the date', () => {
  assert.equal(currentSemester(AUGUST).value, 'Summer 2026');
  assert.equal(currentSemester(OCTOBER).value, 'Fall 2026');
  assert.equal(currentSemester(FEBRUARY).value, 'Spring 2026');
});

test('options span two years either side, newest first', () => {
  const options = semesterOptions(AUGUST);

  assert.equal(options.length, 15, '5 years x 3 terms');
  assert.equal(options[0].value, 'Fall 2028', 'newest first');
  assert.equal(options.at(-1)?.value, 'Spring 2024', 'oldest last');

  const years = Array.from(new Set(options.map((option) => option.year)));
  assert.deepEqual(years, [2028, 2027, 2026, 2025, 2024]);
});

test('the default selection is present in the option list', () => {
  for (const now of [AUGUST, OCTOBER, FEBRUARY]) {
    const preselected = currentSemester(now).value;
    assert.ok(
      semesterOptions(now).some((option) => option.value === preselected),
      `${preselected} must be selectable`,
    );
  }
});

test('free-text spellings this replaced are not treated as known values', () => {
  assert.ok(isKnownSemester('Fall 2026', AUGUST));
  assert.ok(!isKnownSemester('fall 2026', AUGUST));
  assert.ok(!isKnownSemester('Fall24', AUGUST));
  assert.ok(!isKnownSemester('Autumn 2026', AUGUST));
});
