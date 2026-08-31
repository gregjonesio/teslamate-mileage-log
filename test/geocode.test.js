import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from '../src/geocode.js';

test('plain address yields itself', () => {
  assert.deepEqual(candidates('325 Durley Ave, Camarillo, CA 93010'), [
    '325 Durley Ave, Camarillo, CA 93010',
  ]);
});

test('venue with parenthesized address yields address and venue fallbacks', () => {
  const c = candidates('Waypoint Café - Camarillo Airport (325 Durley Ave, Camarillo, CA  93010)');
  assert.equal(c[0], 'Waypoint Café - Camarillo Airport (325 Durley Ave, Camarillo, CA  93010)');
  assert.equal(c[1], '325 Durley Ave, Camarillo, CA  93010');
  assert.equal(c[2], 'Waypoint Café - Camarillo Airport');
});

test('deduplicates and drops empties', () => {
  assert.deepEqual(candidates('  Somewhere  '), ['Somewhere']);
});

test('a structured address from the event outranks the display name', () => {
  assert.deepEqual(candidates('Some Venue', '2800 E Observatory Rd, Los Angeles, CA'), [
    '2800 E Observatory Rd, Los Angeles, CA',
    'Some Venue',
  ]);
});
