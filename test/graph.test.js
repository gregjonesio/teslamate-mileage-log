import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLocation, isVirtual } from '../src/graph.js';

// A venue picked from Outlook's location search: the display name is a bare
// venue name no geocoder resolves, but the event carries address + coordinates.
test('a resolved venue keeps its structured address and coordinates', () => {
  const loc = parseEventLocation({
    displayName: 'Griffith Observatory',
    locationType: 'localBusiness',
    address: {
      street: '2800 E Observatory Rd',
      city: 'Los Angeles',
      state: 'CA',
      countryOrRegion: 'United States',
      postalCode: '',
    },
    coordinates: { latitude: 34.1184, longitude: -118.3004 },
  });
  assert.equal(loc.name, 'Griffith Observatory');
  assert.equal(loc.address, '2800 E Observatory Rd, Los Angeles, CA');
  assert.equal(loc.lat, 34.1184);
  assert.equal(loc.lon, -118.3004);
});

test('a postal code joins the state', () => {
  const loc = parseEventLocation({
    displayName: 'Somewhere',
    address: { street: '1 Example Way', city: 'Pasadena', state: 'CA', postalCode: '91101' },
  });
  assert.equal(loc.address, '1 Example Way, Pasadena, CA 91101');
});

test('a hand-typed location has neither address nor coordinates', () => {
  const loc = parseEventLocation({
    displayName: '1 Example Way (1 Example Way, Pasadena, California  91101)',
    locationType: 'default',
    address: {},
    coordinates: {},
  });
  assert.equal(loc.name, '1 Example Way (1 Example Way, Pasadena, California  91101)');
  assert.equal(loc.address, null);
  assert.equal(loc.lat, null);
  assert.equal(loc.lon, null);
});

test('an address without a street is not worth geocoding', () => {
  const loc = parseEventLocation({
    displayName: 'Somewhere',
    address: { city: 'Los Angeles', state: 'CA', countryOrRegion: 'United States' },
  });
  assert.equal(loc.address, null);
});

test('out-of-range coordinates are rejected so geocoding still runs', () => {
  const loc = parseEventLocation({
    displayName: 'Somewhere',
    coordinates: { latitude: 134.0, longitude: -118.3 },
  });
  assert.equal(loc.lat, null);
  assert.equal(loc.lon, null);
});

test('a missing location yields an empty name', () => {
  assert.equal(parseEventLocation(undefined).name, '');
  assert.equal(parseEventLocation({}).name, '');
});

test('meeting URLs are recognised as virtual', () => {
  assert.ok(isVirtual('https://example.zoom.us/j/123'));
  assert.ok(!isVirtual('Griffith Observatory'));
});
