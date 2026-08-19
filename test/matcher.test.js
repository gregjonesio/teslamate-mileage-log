import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTrips, haversineMeters } from '../src/matcher.js';

// Office at roughly downtown LA; meeting venue ~5 km away.
const OFFICE = { lat: 34.0522, lon: -118.2437 };
const VENUE = { lat: 34.0928, lon: -118.3287 };
const NEAR_VENUE = { lat: 34.0930, lon: -118.3285 }; // ~30 m from VENUE

function drive(id, startIso, endIso, from, to, miles = 6.2) {
  return {
    id,
    start: new Date(startIso),
    end: new Date(endIso),
    miles,
    startLat: from.lat,
    startLon: from.lon,
    endLat: to.lat,
    endLon: to.lon,
    startAddress: '',
    endAddress: '',
  };
}

function meeting(id, startIso, endIso, coords = VENUE) {
  return {
    id,
    subject: `Meeting ${id}`,
    location: '123 Test St, Los Angeles, CA',
    start: new Date(startIso),
    end: new Date(endIso),
    lat: coords.lat,
    lon: coords.lon,
  };
}

test('haversine distance is sane', () => {
  const d = haversineMeters(VENUE.lat, VENUE.lon, NEAR_VENUE.lat, NEAR_VENUE.lon);
  assert.ok(d > 5 && d < 100, `expected ~30m, got ${d}`);
});

test('matches an outbound drive ending near the meeting before it starts', () => {
  const drives = [drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE)];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'high');
});

test('picks up the return drive departing from the venue after the meeting', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE),
    drive(2, '2026-08-10T18:15:00Z', '2026-08-10T18:45:00Z', NEAR_VENUE, OFFICE),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries[0].return.id, 2);
});

test('ignores drives ending too far away or outside the arrival window', () => {
  const farAway = { lat: 34.20, lon: -118.60 };
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, farAway),
    drive(2, '2026-08-10T10:00:00Z', '2026-08-10T10:30:00Z', OFFICE, NEAR_VENUE), // hours early
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives).length, 0);
});

test('a drive is claimed by only one meeting (nearest-in-time processed first)', () => {
  const drives = [drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE)];
  const meetings = [
    meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T17:30:00Z'),
    meeting('m2', '2026-08-10T17:45:00Z', '2026-08-10T18:15:00Z'),
  ];
  const entries = matchTrips(meetings, drives, { includeReturn: false });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meeting.id, 'm1');
});

test('meetings without geocoded coordinates are skipped', () => {
  const drives = [drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE)];
  const m = meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z');
  m.lat = null;
  m.lon = null;
  assert.equal(matchTrips([m], drives).length, 0);
});

// A rail/air trip: the car stops at the hub, the meeting is a long way past it.
const HUB = { name: 'Union Station', lat: 33.7503, lon: -117.8583 };
const NEAR_HUB = { lat: 33.7509, lon: -117.8566 }; // ~170 m from HUB
const HUBS = [HUB];

test('matches a drive that ended at a transport hub to a distant meeting', () => {
  const drives = [drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1)];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  const entries = matchTrips(meetings, drives, { hubs: HUBS });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'via-hub');
  assert.equal(entries[0].hub.name, 'Union Station');
  assert.equal(entries[0].destination, 'Union Station');
});

test('pairs the drive home from the same hub as the return leg', () => {
  const drives = [
    drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1),
    drive(2, '2026-08-20T01:30:00Z', '2026-08-20T02:05:00Z', NEAR_HUB, OFFICE, 14.1),
  ];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  const entries = matchTrips(meetings, drives, { hubs: HUBS });
  assert.equal(entries[0].return.id, 2);
});

test('a return drive from the hub beyond the cap is left unclaimed', () => {
  const drives = [
    drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1),
    drive(2, '2026-08-20T12:00:00Z', '2026-08-20T12:35:00Z', NEAR_HUB, OFFICE, 14.1),
  ];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  const entries = matchTrips(meetings, drives, { hubs: HUBS, hubReturnMaxHours: 12 });
  assert.equal(entries[0].return, null);
});

test('hub matching respects the departure window', () => {
  // Left for the hub 10 hours before the meeting; the default window is 8.
  const drives = [drive(1, '2026-08-19T09:30:00Z', '2026-08-19T10:00:00Z', OFFICE, NEAR_HUB, 14.1)];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  assert.equal(matchTrips(meetings, drives, { hubs: HUBS }).length, 0);
  assert.equal(matchTrips(meetings, drives, { hubs: HUBS, hubDepartEarlyMin: 720 }).length, 1);
});

test('a drive reaching the hub after the meeting started is not the outbound leg', () => {
  const drives = [drive(1, '2026-08-19T20:30:00Z', '2026-08-19T21:00:00Z', OFFICE, NEAR_HUB, 14.1)];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  assert.equal(matchTrips(meetings, drives, { hubs: HUBS }).length, 0);
});

test('a direct drive to the venue wins, and the hub drive stays unclaimed', () => {
  const drives = [
    drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1),
    drive(2, '2026-08-19T19:10:00Z', '2026-08-19T19:40:00Z', OFFICE, NEAR_VENUE),
  ];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  const entries = matchTrips(meetings, drives, { hubs: HUBS });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outbound.id, 2);
  assert.equal(entries[0].confidence, 'high');
  assert.equal(entries[0].hub, null);
});

test('the last departure before the meeting is the one that counts', () => {
  const drives = [
    drive(1, '2026-08-19T14:00:00Z', '2026-08-19T14:30:00Z', OFFICE, NEAR_HUB, 14.1),
    drive(2, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1),
  ];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  assert.equal(matchTrips(meetings, drives, { hubs: HUBS })[0].outbound.id, 2);
});

test('without configured hubs nothing changes', () => {
  const drives = [drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1)];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  assert.equal(matchTrips(meetings, drives).length, 0);
});

test('per-hub radius overrides the default', () => {
  const far = { lat: 33.7570, lon: -117.8583 }; // ~745 m from HUB
  const drives = [drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, far, 14.1)];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  assert.equal(matchTrips(meetings, drives, { hubs: [HUB], hubRadiusM: 500 }).length, 0);
  assert.equal(
    matchTrips(meetings, drives, { hubs: [{ ...HUB, radiusM: 1200 }], hubRadiusM: 500 }).length,
    1
  );
});
