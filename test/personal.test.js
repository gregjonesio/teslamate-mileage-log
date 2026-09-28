import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePersonalTerms,
  loadPersonalTerms,
  personalReason,
  splitPersonal,
} from '../src/personal.js';
import { matchTrips } from '../src/matcher.js';

const RULES = { terms: ['Dentist', 'Sam'], marker: '(personal)' };
const meeting = (subject, extra = {}) => ({ id: subject, subject, sensitivity: 'normal', ...extra });

// Accents are built from code points so the source stays ASCII: an editor
// that normalises the file cannot quietly turn one form into the other.
const ACUTE = String.fromCodePoint(0x301); // combining acute accent
const MACRON_BELOW = String.fromCodePoint(0x331); // combines with "e" to no single character
const E_ACUTE = String.fromCodePoint(0xe9); // "e" with acute, as one character

test('parses personal terms', () => {
  assert.deepEqual(parsePersonalTerms('["Dentist", " School pickup "]'), [
    'Dentist',
    'School pickup',
  ]);
});

test('names the offending entry when a term is malformed', () => {
  assert.throws(() => parsePersonalTerms('{"a":1}'), /must contain a JSON array/);
  assert.throws(() => parsePersonalTerms('nope'), /not valid JSON/);
  assert.throws(() => parsePersonalTerms('["ok", ""]'), /entry 2 must be a non-empty string/);
  assert.throws(() => parsePersonalTerms('["ok", 7]'), /entry 2 must be a non-empty string/);
});

test('duplicate terms are rejected', () => {
  assert.throws(() => parsePersonalTerms('["Dentist","DENTIST"]'), /lists "DENTIST" more than once/);
});

test('the same accented term typed two ways is a duplicate', () => {
  const json = JSON.stringify([`Caf${E_ACUTE}`, `Cafe${ACUTE}`]);
  assert.throws(() => parsePersonalTerms(json), /more than once/);
});

test('a missing personal file just means no terms', () => {
  assert.deepEqual(loadPersonalTerms('./definitely-not-here.json', { required: false }), []);
});

// A mistyped path must not quietly switch the terms off.
test('a missing file that was configured explicitly is an error', () => {
  assert.throws(
    () => loadPersonalTerms('./definitely-not-here.json', { required: true }),
    /PERSONAL_FILE points to .*definitely-not-here\.json, which does not exist/
  );
});

// The regression this feature exists for: a personal event with a street
// address matched a drive and entered the business log with high confidence.
test('a subject carrying the marker is personal, in any case', () => {
  assert.equal(personalReason(meeting('Lunch (Personal)'), RULES), 'subject contains "(personal)"');
  assert.equal(personalReason(meeting('Quarterly lunch'), RULES), null);
});

test('an empty or missing marker turns the marker rule off', () => {
  for (const marker of ['', '  ', null, undefined]) {
    assert.equal(personalReason(meeting('Lunch (Personal)'), { terms: [], marker }), null);
  }
});

test('a listed term matches as a whole word, in any case', () => {
  assert.equal(personalReason(meeting('dentist appointment'), RULES), 'personal term "Dentist"');
  assert.equal(personalReason(meeting('Pick up Sam'), RULES), 'personal term "Sam"');
  assert.equal(personalReason(meeting("Sam's recital"), RULES), 'personal term "Sam"');
});

// A short name must never swallow a business subject that merely contains it.
test('a term inside a longer word does not match', () => {
  assert.equal(personalReason(meeting('Samsung product demo'), RULES), null);
  assert.equal(personalReason(meeting('Balsam Partners lunch'), RULES), null);
});

test('a digit or an accent after the term makes it another word', () => {
  const rules = { terms: ['Cafe', 'Gate 4'], marker: '' };
  assert.equal(personalReason(meeting('Gate 42 walkthrough'), rules), null);
  assert.equal(personalReason(meeting('Cafe, 9am'), rules), 'personal term "Cafe"');

  // An accent that joins the "e" into one character, and one that cannot.
  assert.equal(personalReason(meeting(`Cafe${ACUTE}teria planning`), rules), null);
  const marked = `Cafe${MACRON_BELOW} planning`;
  assert.match(marked.normalize('NFC'), /\p{M}/u, 'fixture must keep its combining mark');
  assert.equal(personalReason(meeting(marked), rules), null);
});

test('an accented term matches however it was typed', () => {
  const composed = `Caf${E_ACUTE}`;
  const decomposed = `Cafe${ACUTE}`;
  assert.notEqual(composed, decomposed);
  assert.ok(personalReason(meeting(`${decomposed} with family`), { terms: [composed], marker: '' }));
  assert.ok(personalReason(meeting(`${composed} with family`), { terms: [decomposed], marker: '' }));
});

test('a term with punctuation is matched literally', () => {
  const rules = { terms: ['P.T.A. (spring)'], marker: '' };
  assert.equal(
    personalReason(meeting('P.T.A. (spring) meeting'), rules),
    'personal term "P.T.A. (spring)"'
  );
  assert.equal(personalReason(meeting('PXTXAX spring meeting'), rules), null);
});

test('an event Outlook marks personal needs no rule', () => {
  assert.equal(
    personalReason(meeting('Anything', { sensitivity: 'personal' }), { terms: [], marker: '' }),
    'marked personal in Outlook'
  );
});

// Private is a visibility setting, not a statement about purpose: a
// confidential client meeting is private and still business.
test('a private event is still business', () => {
  assert.equal(personalReason(meeting('Board dinner', { sensitivity: 'private' }), RULES), null);
});

test('with no rules every meeting is business', () => {
  assert.equal(personalReason(meeting('Dentist (personal)')), null);
  assert.equal(personalReason({ id: 1 }, RULES), null);
});

test('splits meetings and keeps the reason for each personal one', () => {
  const lunch = meeting('Client lunch');
  const dentist = meeting('Dentist');
  const { business, personal } = splitPersonal([lunch, dentist], RULES);
  assert.deepEqual(business, [lunch]);
  assert.deepEqual(personal, [{ meeting: dentist, reason: 'personal term "Dentist"' }]);
});

// --- with the matcher -------------------------------------------------------
const HOME = { lat: 34.0522, lon: -118.2437 };
const VENUE = { lat: 34.0928, lon: -118.3287 };
const arrival = {
  id: 1,
  start: new Date('2026-08-10T16:10:00Z'),
  end: new Date('2026-08-10T16:40:00Z'),
  miles: 6.2,
  startLat: HOME.lat,
  startLon: HOME.lon,
  endLat: VENUE.lat,
  endLon: VENUE.lon,
  startAddress: '',
  endAddress: '',
};
const at = (subject) => ({
  ...meeting(subject),
  location: '123 Test St, Los Angeles, CA',
  start: new Date('2026-08-10T17:00:00Z'),
  end: new Date('2026-08-10T18:00:00Z'),
  lat: VENUE.lat,
  lon: VENUE.lon,
});

test('a drive to a personal event is left unclaimed', () => {
  // Without the filter the same event claims the drive: the defect itself.
  assert.equal(matchTrips([at('Dentist')], [arrival]).length, 1);
  const { business } = splitPersonal([at('Dentist')], RULES);
  assert.deepEqual(matchTrips(business, [arrival]), []);
});

// Skipping an event does not reserve its drive: a business meeting at the
// same place and time still claims it, and the personal one never competes.
test('a business meeting at the same place still claims the drive', () => {
  const { business } = splitPersonal([at('Dentist'), at('Client lunch')], RULES);
  const entries = matchTrips(business, [arrival]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meeting.subject, 'Client lunch');
  assert.equal(entries[0].outbound.id, 1);
});
