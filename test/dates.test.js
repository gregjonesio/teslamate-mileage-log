import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateRange, localDateString, localDateTimeString } from '../src/dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('--to is inclusive: a single day is a full 24-hour window', () => {
  const { from, to } = parseDateRange('2026-08-19', '2026-08-19');
  assert.equal(to - from, DAY_MS);
  assert.equal(localDateString(from), '2026-08-19');
});

test('window boundaries are local midnights, not UTC midnights', () => {
  const { from, to } = parseDateRange('2026-08-19', '2026-08-19');
  assert.equal(from.getHours(), 0);
  assert.equal(from.getMinutes(), 0);
  assert.equal(to.getHours(), 0);
});

test('a drive on the evening of the last day is inside the window', () => {
  // 6pm local on the closing day is already the next day in UTC; the old
  // UTC-midnight window dropped it silently.
  const { from, to } = parseDateRange('2026-08-01', '2026-08-19');
  const eveningDrive = new Date(2026, 7, 19, 18, 30);
  assert.ok(eveningDrive >= from && eveningDrive < to);
});

test('multi-day range spans every day inclusive of both ends', () => {
  const { from, to } = parseDateRange('2026-01-01', '2026-06-30');
  assert.equal(localDateString(from), '2026-01-01');
  assert.ok(new Date(2026, 5, 30, 23, 59) < to);
  assert.ok(new Date(2026, 6, 1, 0, 0) >= to);
});

test('day arithmetic survives a DST transition', () => {
  // Nov 1 2026 is the US fall-back date: that local day is 25 hours long.
  const { from, to } = parseDateRange('2026-11-01', '2026-11-01');
  assert.equal(from.getHours(), 0);
  assert.equal(to.getHours(), 0);
  assert.equal(localDateString(to), '2026-11-02');
});

test('rejects malformed, impossible, and backwards ranges', () => {
  assert.throws(() => parseDateRange('8/19/2026', '2026-08-19'), /--from/);
  assert.throws(() => parseDateRange('2026-08-19', 'today'), /--to/);
  assert.throws(() => parseDateRange('2026-02-30', '2026-03-01'), /not a real date/);
  assert.throws(() => parseDateRange('2026-08-20', '2026-08-19'), /before --from/);
});

test('localDateString and localDateTimeString use the local calendar day', () => {
  const evening = new Date(2026, 7, 19, 18, 5);
  assert.equal(localDateString(evening), '2026-08-19');
  assert.equal(localDateTimeString(evening), '2026-08-19 18:05');
});
