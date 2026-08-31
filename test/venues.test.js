import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVenues, loadVenues, resolveVenue } from '../src/venues.js';

const VENUES = parseVenues('[{"name":"Griffith Observatory","lat":34.1184,"lon":-118.3004}]');

test('parses venue aliases', () => {
  assert.deepEqual(VENUES, [{ name: 'Griffith Observatory', lat: 34.1184, lon: -118.3004 }]);
});

test('names the offending entry when a venue is malformed', () => {
  assert.throws(() => parseVenues('{"name":"A"}'), /must contain a JSON array/);
  assert.throws(() => parseVenues('nope'), /not valid JSON/);
  assert.throws(() => parseVenues('[{"lat":1,"lon":2}]'), /entry 1 needs a "name"/);
  assert.throws(() => parseVenues('[{"name":"A","lat":100,"lon":2}]'), /valid "lat"/);
  assert.throws(() => parseVenues('[{"name":"A","lat":1,"lon":200}]'), /valid "lon"/);
});

test('duplicate venue names are rejected', () => {
  assert.throws(
    () => parseVenues('[{"name":"Cafe","lat":1,"lon":2},{"name":"CAFE","lat":3,"lon":4}]'),
    /lists "CAFE" more than once/
  );
});

test('a missing venues file just means no aliases', () => {
  assert.deepEqual(loadVenues('./definitely-not-here.json'), []);
});

// The regression this feature exists for: a meeting whose location is a bare
// venue name that the geocoder cannot resolve at all.
test('resolves a bare venue name case-insensitively', () => {
  assert.deepEqual(resolveVenue('GRIFFITH OBSERVATORY', VENUES), {
    lat: 34.1184,
    lon: -118.3004,
  });
  assert.equal(resolveVenue('Elsewhere', VENUES), null);
});

test('matches the venue-name part of a "Name (address)" location', () => {
  const hit = resolveVenue('Griffith Observatory (2800 E Observatory Rd, Los Angeles)', VENUES);
  assert.deepEqual(hit, { lat: 34.1184, lon: -118.3004 });
});
