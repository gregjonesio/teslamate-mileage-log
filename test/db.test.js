import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import '../src/db.js';

test('timestamp without time zone is parsed as UTC, not machine-local', () => {
  // TeslaMate writes UTC into these columns; node-pg's default parser reads
  // them as local time, which shifted every drive by the local UTC offset.
  const parse = pg.types.getTypeParser(pg.types.builtins.TIMESTAMP);
  assert.equal(parse('2026-08-19 16:11:04.65').toISOString(), '2026-08-19T16:11:04.650Z');
  assert.equal(parse('2026-08-19 16:11:04').toISOString(), '2026-08-19T16:11:04.000Z');
  assert.equal(parse('2026-01-05 00:00:00').toISOString(), '2026-01-05T00:00:00.000Z');
});
