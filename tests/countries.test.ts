import assert from 'node:assert/strict';
import test from 'node:test';
import { allCountries, countryCodeForName, countryNameForCode } from '../lib/countries';

test('the list is populated, sorted and free of duplicates', () => {
  const countries = allCountries();

  assert.ok(countries.length > 150, 'should cover most of ISO 3166-1');
  assert.equal(
    new Set(countries.map((country) => country.code)).size,
    countries.length,
    'codes must be unique',
  );

  const names = countries.map((country) => country.name);
  assert.deepEqual(
    names,
    Array.from(names).sort((a, b) => a.localeCompare(b)),
    'sorted by name',
  );
});

test('countries the platform already has institutions in are all present', () => {
  const codes = new Set(allCountries().map((country) => country.code));
  for (const code of ['BD', 'US', 'GB', 'SG', 'CH', 'IN']) {
    assert.ok(codes.has(code), `${code} must be selectable`);
  }
});

test('names resolve rather than falling back to raw codes', () => {
  // If Intl were unavailable the fallback returns the code itself, which would
  // put "BD" in front of a user instead of "Bangladesh".
  assert.equal(countryNameForCode('BD'), 'Bangladesh');
  assert.equal(countryNameForCode('US'), 'United States');
});

test('a stored country name maps back to its code for preselection', () => {
  // profiles.country stores the display name, so onboarding has to reverse it
  // to preselect the country field.
  assert.equal(countryCodeForName('Bangladesh'), 'BD');
  assert.equal(countryCodeForName('  bangladesh  '), 'BD', 'tolerant of case and padding');
  assert.equal(countryCodeForName('Atlantis'), '', 'unknown names yield empty, not a throw');
  assert.equal(countryCodeForName(null), '');
  assert.equal(countryCodeForName(undefined), '');
});

test('the round trip is stable for every country', () => {
  for (const country of allCountries()) {
    assert.equal(
      countryCodeForName(country.name),
      country.code,
      `${country.name} should map back to ${country.code}`,
    );
  }
});
