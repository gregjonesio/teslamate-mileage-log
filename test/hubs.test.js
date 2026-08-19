import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHubs, loadHubs } from '../src/hubs.js';

test('parses hubs and keeps an optional per-hub radius', () => {
  const hubs = parseHubs('[{"name":"SARTC","lat":33.7503,"lon":-117.8583},' +
    '{"name":"Camarillo","lat":34.2137,"lon":-119.0944,"radiusM":1200}]');
  assert.equal(hubs.length, 2);
  assert.deepEqual(hubs[0], { name: 'SARTC', lat: 33.7503, lon: -117.8583 });
  assert.equal(hubs[1].radiusM, 1200);
});

test('names the offending entry when a hub is malformed', () => {
  assert.throws(() => parseHubs('{"name":"SARTC"}'), /must contain a JSON array/);
  assert.throws(() => parseHubs('nope'), /not valid JSON/);
  assert.throws(() => parseHubs('[{"lat":1,"lon":2}]'), /entry 1 needs a "name"/);
  assert.throws(() => parseHubs('[{"name":"A","lat":1,"lon":2},{"name":"B","lon":2}]'), /entry 2 \("B"\) needs a valid "lat"/);
  assert.throws(() => parseHubs('[{"name":"A","lat":100,"lon":2}]'), /valid "lat"/);
  assert.throws(() => parseHubs('[{"name":"A","lat":1,"lon":200}]'), /valid "lon"/);
  assert.throws(() => parseHubs('[{"name":"A","lat":1,"lon":2,"radiusM":0}]'), /invalid "radiusM"/);
});

test('a missing hubs file just means hub matching is off', () => {
  assert.deepEqual(loadHubs('./definitely-not-here.json'), []);
});
