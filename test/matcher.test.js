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

// Parking shuffles: a sub-mile hop near the venue must not be taken as the return.
const VENUE_BLOCK = { lat: 34.0946, lon: -118.3287 }; // ~200 m from VENUE
const AWAY = { lat: 34.0985, lon: -118.3287 }; // ~630 m from VENUE, ~430 m from VENUE_BLOCK

test('a parking shuffle near the venue is not the return leg', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 43.9),
    drive(2, '2026-08-10T18:05:00Z', '2026-08-10T18:07:00Z', NEAR_VENUE, VENUE_BLOCK, 0.1),
    drive(3, '2026-08-10T18:30:00Z', '2026-08-10T19:20:00Z', VENUE_BLOCK, OFFICE, 46.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].return.id, 3);
});

test('the return is found even when a shuffle moved the car outside the match radius', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 43.9),
    drive(2, '2026-08-10T18:05:00Z', '2026-08-10T18:08:00Z', NEAR_VENUE, AWAY, 0.4),
    drive(3, '2026-08-10T18:30:00Z', '2026-08-10T19:20:00Z', AWAY, OFFICE, 46.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries[0].return.id, 3);
});

test('a drive exactly at the reposition threshold is still a shuffle', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 43.9),
    drive(2, '2026-08-10T18:05:00Z', '2026-08-10T18:10:00Z', NEAR_VENUE, VENUE_BLOCK, 1.0),
    drive(3, '2026-08-10T18:30:00Z', '2026-08-10T19:20:00Z', VENUE_BLOCK, OFFICE, 46.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 3);
});

test('a drive with unknown mileage is never treated as a shuffle', () => {
  // null <= 1 is true in JS; such a drive must stay a visible return candidate
  // (and land in the CSV for review) instead of silently vanishing as a hop.
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 43.9),
    drive(2, '2026-08-10T18:05:00Z', '2026-08-10T18:07:00Z', NEAR_VENUE, VENUE_BLOCK, null),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 2);
});

test('with only a shuffle available the return stays empty', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 43.9),
    drive(2, '2026-08-10T18:05:00Z', '2026-08-10T18:07:00Z', NEAR_VENUE, VENUE_BLOCK, 0.1),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries[0].return, null);
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

test('a parking shuffle at the hub is not the drive home', () => {
  const NEAR_HUB2 = { lat: 33.7523, lon: -117.8583 }; // ~220 m from HUB
  const drives = [
    drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1),
    drive(2, '2026-08-19T22:30:00Z', '2026-08-19T22:33:00Z', NEAR_HUB, NEAR_HUB2, 0.2),
    drive(3, '2026-08-19T23:30:00Z', '2026-08-20T00:05:00Z', NEAR_HUB2, OFFICE, 14.1),
  ];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  const entries = matchTrips(meetings, drives, { hubs: HUBS });
  assert.equal(entries[0].return.id, 3);
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

// Long blocks and late arrivals: the window stays open until the meeting ends.
test('arriving partway through a long block still matches', () => {
  const drives = [drive(1, '2026-08-10T17:05:00Z', '2026-08-10T17:58:00Z', OFFICE, NEAR_VENUE, 46.1)];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T19:30:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'high');
});

test('a drive ending after the meeting is over is not the outbound leg', () => {
  const drives = [drive(1, '2026-08-10T19:00:00Z', '2026-08-10T19:45:00Z', OFFICE, NEAR_VENUE, 46.1)];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T19:30:00Z')];
  assert.equal(matchTrips(meetings, drives).length, 0);
});

test('the late-arrival allowance still applies to a meeting shorter than it', () => {
  // 15-minute meeting, arrival 18 minutes after the start: inside ARRIVE_LATE_MIN.
  const drives = [drive(1, '2026-08-10T16:40:00Z', '2026-08-10T17:18:00Z', OFFICE, NEAR_VENUE, 12.0)];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T17:15:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].outbound.id, 1);
});

test('the first arrival is the outbound leg, not a later closer one', () => {
  // Arrive, leave for lunch partway through the block, come back, drive home after.
  const LUNCH = { lat: 34.1100, lon: -118.3287 }; // ~1.9 km from VENUE
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, VENUE_BLOCK, 46.1),
    drive(2, '2026-08-10T19:00:00Z', '2026-08-10T19:06:00Z', VENUE_BLOCK, LUNCH, 1.4),
    drive(3, '2026-08-10T19:50:00Z', '2026-08-10T19:56:00Z', LUNCH, NEAR_VENUE, 1.4),
    drive(4, '2026-08-10T21:10:00Z', '2026-08-10T22:00:00Z', NEAR_VENUE, OFFICE, 44.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T21:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'high');
  assert.equal(entries[0].return.id, 4);
});

// Arrival-side repositioning: parked out of radius, then moved the car closer.
const OUTSIDE = { lat: 34.0985, lon: -118.3287 }; // ~630 m from VENUE (same point as AWAY)

test('a parked-then-moved arrival is credited to the drive that made the trip', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, OUTSIDE, 46.1),
    drive(2, '2026-08-10T16:44:00Z', '2026-08-10T16:47:00Z', OUTSIDE, NEAR_VENUE, 0.5),
    drive(3, '2026-08-10T18:30:00Z', '2026-08-10T19:20:00Z', NEAR_VENUE, OFFICE, 44.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'high'); // judged by where the car ended up
  assert.equal(entries[0].return.id, 3);
});

test('a hop that no earlier drive explains is still the outbound leg', () => {
  const drives = [drive(2, '2026-08-10T16:44:00Z', '2026-08-10T16:47:00Z', OUTSIDE, NEAR_VENUE, 0.5)];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].outbound.id, 2);
});

test('a stop just short of the venue followed by a hop is one arrival, parked where the hop left it', () => {
  // Long block, arrive an hour in and stop inside the radius but not at the
  // venue, then move the car the last few hundred metres.
  const drives = [
    drive(1, '2026-08-10T17:05:00Z', '2026-08-10T17:58:00Z', OFFICE, AWAY, 46.1),
    drive(2, '2026-08-10T18:03:00Z', '2026-08-10T18:06:00Z', AWAY, NEAR_VENUE, 0.5),
    drive(3, '2026-08-10T19:50:00Z', '2026-08-10T20:40:00Z', NEAR_VENUE, OFFICE, 44.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T19:30:00Z')];
  const entries = matchTrips(meetings, drives, { radiusM: 700 });
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'high');
  assert.equal(entries[0].return.id, 3);
});

// Errands on the way home: a short stop is skipped when a real drive follows it.
const STORE = { lat: 34.1120, lon: -118.3287 }; // ~2.1 km from VENUE
const STORE2 = { lat: 34.1120, lon: -118.3500 }; // ~2 km from STORE

test('a short errand stop on the way home is skipped and the drive home is the return', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
    drive(3, '2026-08-10T18:49:00Z', '2026-08-10T20:16:00Z', STORE, OFFICE, 43.8),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 3);
});

test('errand stops chain until a substantive drive follows', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
    drive(3, '2026-08-10T18:45:00Z', '2026-08-10T18:52:00Z', STORE, STORE2, 1.5),
    drive(4, '2026-08-10T19:10:00Z', '2026-08-10T20:16:00Z', STORE2, OFFICE, 41.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 4);
});

test('a short drive that nothing longer follows is still the return', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 2);
});

test('a long stay after a short drive means the short drive was the destination', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
    drive(3, '2026-08-10T21:40:00Z', '2026-08-10T23:00:00Z', STORE, OFFICE, 43.8), // 3 h later
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 2);
});

test('a drive above the errand cap is the return even when something longer follows', () => {
  const FAR_STORE = { lat: 34.1500, lon: -118.3287 }; // ~6 km from VENUE
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:35:00Z', NEAR_VENUE, FAR_STORE, 4.0),
    drive(3, '2026-08-10T18:49:00Z', '2026-08-10T20:16:00Z', FAR_STORE, OFFICE, 43.8),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 2);
});

test('errand handling can be switched off', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
    drive(3, '2026-08-10T18:49:00Z', '2026-08-10T20:16:00Z', STORE, OFFICE, 43.8),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives, { errandMaxMiles: 0 })[0].return.id, 2);
});

test('a drive with unknown mileage after an errand is taken as the return', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
    drive(3, '2026-08-10T18:49:00Z', '2026-08-10T20:16:00Z', STORE, OFFICE, null),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 3);
});

// Continuity: hops are followed only along the car's own consecutive drives.
test('an intervening trip breaks the hop chain, so a later hop does not upgrade confidence', () => {
  const drives = [
    drive(1, '2026-08-10T17:05:00Z', '2026-08-10T17:58:00Z', OFFICE, AWAY, 46.1),
    drive(2, '2026-08-10T18:03:00Z', '2026-08-10T18:20:00Z', AWAY, OFFICE, 44.0),
    drive(3, '2026-08-10T18:40:00Z', '2026-08-10T19:00:00Z', OFFICE, AWAY, 44.0),
    drive(4, '2026-08-10T19:05:00Z', '2026-08-10T19:08:00Z', AWAY, NEAR_VENUE, 0.5),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T21:00:00Z')];
  const entries = matchTrips(meetings, drives, { radiusM: 700 });
  assert.equal(entries[0].outbound.id, 1);
  assert.equal(entries[0].confidence, 'medium'); // parked 630 m out; the later hop is another visit
});

test('a hop is credited to the drive just before it, even one ending before the window opens', () => {
  const drives = [
    drive(1, '2026-08-10T14:10:00Z', '2026-08-10T14:40:00Z', OFFICE, OUTSIDE, 46.1), // 2h20 early
    drive(2, '2026-08-10T16:44:00Z', '2026-08-10T16:47:00Z', OUTSIDE, NEAR_VENUE, 0.5),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].outbound.id, 1);
});

test('a hop is not credited to an earlier drive that ended somewhere else', () => {
  const drives = [
    drive(1, '2026-08-10T15:10:00Z', '2026-08-10T15:40:00Z', OFFICE, AWAY, 46.1),
    drive(2, '2026-08-10T16:44:00Z', '2026-08-10T16:47:00Z', OUTSIDE, NEAR_VENUE, 0.5), // AWAY == OUTSIDE
  ];
  const far = { lat: 34.20, lon: -118.60 };
  drives[0].endLat = far.lat;
  drives[0].endLon = far.lon;
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].outbound.id, 2);
});

test('an early drop-off the car left again is passed over for the arrival that stayed', () => {
  const drives = [
    drive(1, '2026-08-10T15:10:00Z', '2026-08-10T15:15:00Z', OFFICE, NEAR_VENUE, 8.0),
    drive(2, '2026-08-10T15:20:00Z', '2026-08-10T15:40:00Z', NEAR_VENUE, OFFICE, 8.0),
    drive(3, '2026-08-10T16:30:00Z', '2026-08-10T16:55:00Z', OFFICE, VENUE_BLOCK, 8.2),
    drive(4, '2026-08-10T18:10:00Z', '2026-08-10T18:40:00Z', VENUE_BLOCK, OFFICE, 8.1),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries[0].outbound.id, 3);
  assert.equal(entries[0].return.id, 4);
});

test('the return must follow the arrival it is paired with', () => {
  // Long block: a departure at 11:10 cannot be the return for an arrival at 11:58.
  const drives = [
    drive(1, '2026-08-10T18:10:00Z', '2026-08-10T18:40:00Z', NEAR_VENUE, OFFICE, 44.0),
    drive(2, '2026-08-10T18:05:00Z', '2026-08-10T18:58:00Z', OFFICE, NEAR_VENUE, 46.1),
    drive(3, '2026-08-10T20:10:00Z', '2026-08-10T21:00:00Z', NEAR_VENUE, OFFICE, 44.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T18:00:00Z', '2026-08-10T20:30:00Z')];
  const entries = matchTrips(meetings, drives);
  assert.equal(entries[0].outbound.id, 2);
  assert.equal(entries[0].return.id, 3);
});

test('errand boundaries: exactly the cap is an errand, just over the gap is not', () => {
  const base = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 3.0),
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  const onTime = [...base, drive(3, '2026-08-10T19:32:00Z', '2026-08-10T20:40:00Z', STORE, OFFICE, 43.8)];
  assert.equal(matchTrips(meetings, onTime)[0].return.id, 3); // gap exactly 60 min
  const late = [...base, drive(3, '2026-08-10T19:33:00Z', '2026-08-10T20:40:00Z', STORE, OFFICE, 43.8)];
  assert.equal(matchTrips(meetings, late)[0].return.id, 2); // 61 min: the store was the destination
});

test('an errand chain breaks when the next drive does not start where the last one ended', () => {
  const drives = [
    drive(1, '2026-08-10T16:10:00Z', '2026-08-10T16:40:00Z', OFFICE, NEAR_VENUE, 48.2),
    drive(2, '2026-08-10T18:20:00Z', '2026-08-10T18:32:00Z', NEAR_VENUE, STORE, 2.1),
    drive(3, '2026-08-10T18:49:00Z', '2026-08-10T20:16:00Z', STORE2, OFFICE, 43.8), // not from STORE
  ];
  const meetings = [meeting('m1', '2026-08-10T17:00:00Z', '2026-08-10T18:00:00Z')];
  assert.equal(matchTrips(meetings, drives)[0].return.id, 2);
});

test('an errand is skipped on the drive home from a hub too', () => {
  const NEAR_HUB_STORE = { lat: 33.7650, lon: -117.8583 }; // ~1.6 km from HUB
  const drives = [
    drive(1, '2026-08-19T16:11:00Z', '2026-08-19T16:45:00Z', OFFICE, NEAR_HUB, 14.1),
    drive(2, '2026-08-20T01:30:00Z', '2026-08-20T01:36:00Z', NEAR_HUB, NEAR_HUB_STORE, 1.2),
    drive(3, '2026-08-20T01:55:00Z', '2026-08-20T02:30:00Z', NEAR_HUB_STORE, OFFICE, 15.0),
  ];
  const meetings = [meeting('m1', '2026-08-19T20:00:00Z', '2026-08-19T22:00:00Z')];
  assert.equal(matchTrips(meetings, drives, { hubs: HUBS })[0].return.id, 3);
});
