import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAutoTags, normalizeTag } from '../lib/auto-tags';

test('normalizeTag collapses punctuation and case', () => {
  assert.equal(normalizeTag('FIN 435'), 'fin-435');
  assert.equal(normalizeTag('  Corporate   Finance!! '), 'corporate-finance');
  assert.equal(normalizeTag('CS-2103T'), 'cs-2103t');
  assert.equal(normalizeTag('---'), '');
});

test('the same course spelled differently produces the same tag', () => {
  // This is the whole point: free text produced fin435 / FIN 435 / Fin-435
  // as three unrelated tags, so tag search matched almost nothing.
  const spaced = ['FIN-435', 'fin 435', 'Fin.435'].map((value) => normalizeTag(value));
  assert.equal(new Set(spaced).size, 1);
  assert.equal(spaced[0], 'fin-435');
});

test('tags are built from the catalog, deduped and capped', () => {
  const tags = buildAutoTags({
    universityShort: 'EWU',
    universityName: 'East West University',
    courseCode: 'FIN-435',
    courseTitle: 'Corporate Finance',
    categoryName: 'Assignments',
    department: 'Finance',
    fileType: 'pdf',
  });

  assert.ok(tags.includes('ewu'));
  assert.ok(tags.includes('fin-435'));
  assert.ok(tags.includes('assignments'));
  assert.ok(tags.includes('pdf'));
  // "University" is a stop word, so the name contributes east-west.
  assert.ok(tags.includes('east-west'));
  assert.equal(new Set(tags).size, tags.length, 'tags must be unique');
  assert.ok(tags.length <= 12);
});

test('missing optional catalog fields simply contribute nothing', () => {
  const tags = buildAutoTags({
    universityShort: 'MIT',
    universityName: 'Massachusetts Institute of Technology',
    courseCode: null,
    courseTitle: null,
    categoryName: null,
    department: null,
    fileType: 'pdf',
  });

  assert.ok(tags.includes('mit'));
  assert.ok(tags.includes('pdf'));
  assert.ok(!tags.some((tag) => tag.includes('institute')), 'stop words are dropped');
});

test('every generated tag satisfies the database constraint', () => {
  const tags = buildAutoTags({
    universityShort: 'X'.repeat(80),
    universityName: 'Y'.repeat(200),
    courseCode: 'Z'.repeat(90),
    categoryName: 'Research Papers',
    fileType: 'pdf',
  });

  for (const tag of tags) {
    assert.ok(tag.length >= 1 && tag.length <= 50, `tag out of range: ${tag}`);
  }
  assert.ok(tags.length <= 30, 'resources.tags allows at most 30 entries');
});
