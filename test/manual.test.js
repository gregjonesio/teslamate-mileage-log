import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/manual.js';

test('parses plain rows', () => {
  assert.deepEqual(parseCsv('date,miles\n2026-01-05,49.3\n'), [
    ['date', 'miles'],
    ['2026-01-05', '49.3'],
  ]);
});

test('handles quoted fields with commas and escaped quotes', () => {
  const rows = parseCsv('date,reason\n2026-01-05,"Lunch, with ""Steve"""\n');
  assert.deepEqual(rows[1], ['2026-01-05', 'Lunch, with "Steve"']);
});

test('handles CRLF line endings and skips trailing blank line', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});
