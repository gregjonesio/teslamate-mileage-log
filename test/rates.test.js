import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IRS_BUSINESS_RATES,
  checkRates,
  parseRates,
  flatRate,
  resolveRates,
  rateOn,
  centsFor,
  deductionFor,
  formatRate,
  describeRates,
} from '../src/rates.js';
import { toCsv, summarize, tripLegs } from '../src/report.js';

const IRS = IRS_BUSINESS_RATES;

test('the built-in IRS table is itself a valid table', () => {
  assert.deepEqual(checkRates([...IRS]), [...IRS]);
});

// The regression this module exists for: one rate applied to a whole year
// that the IRS split in two.
test('a year the IRS split is priced by the day the miles were driven', () => {
  assert.equal(rateOn('2026-06-30', IRS), 0.725);
  assert.equal(rateOn('2026-07-01', IRS), 0.76);
  assert.equal(rateOn('2025-12-31', IRS), 0.7);
  assert.equal(rateOn('2026-01-01', IRS), 0.725);
});

test('a date no rate covers is an error, never a borrowed rate', () => {
  assert.throws(() => rateOn('2021-12-31', IRS), /no mileage rate covers 2021-12-31/);
  assert.throws(() => rateOn('2099-01-01', IRS), /no mileage rate covers 2099-01-01/);
  assert.throws(() => rateOn('2026-02-30', IRS), /cannot price miles dated/);
  assert.throws(() => rateOn(undefined, IRS), /cannot price miles dated/);
});

test('a gap between two rates is not covered by either', () => {
  const rates = checkRates([
    { from: '2030-01-01', to: '2030-03-31', rate: 0.5 },
    { from: '2030-07-01', to: '2030-12-31', rate: 0.6 },
  ]);
  assert.equal(rateOn('2030-03-31', rates), 0.5);
  assert.throws(() => rateOn('2030-05-15', rates), /no mileage rate covers 2030-05-15/);
});

test('entries come back in date order', () => {
  const rates = parseRates(JSON.stringify([
    { from: '2030-07-01', to: '2030-12-31', rate: 0.6 },
    { from: '2030-01-01', to: '2030-06-30', rate: 0.5 },
  ]));
  assert.deepEqual(rates.map((r) => r.from), ['2030-01-01', '2030-07-01']);
});

test('names the offending entry when a rate is malformed', () => {
  const one = (r) => JSON.stringify([r]);
  assert.throws(() => parseRates('nope'), /not valid JSON/);
  assert.throws(() => parseRates('{"rate":1}'), /must contain a JSON array/);
  assert.throws(() => parseRates('[]'), /lists no rates/);
  assert.throws(() => parseRates('[7]'), /entry 1 must be an object/);
  assert.throws(() => parseRates(one({ from: '2030-1-1', to: '2030-12-31', rate: 0.5 })), /entry 1 needs a "from" date/);
  assert.throws(() => parseRates(one({ from: '2030-01-01', to: '2030-02-30', rate: 0.5 })), /entry 1 needs a "to" date/);
  assert.throws(() => parseRates(one({ from: '2030-06-01', to: '2030-01-01', rate: 0.5 })), /ends \(2030-01-01\) before it starts/);
  assert.throws(() => parseRates(one({ from: '2030-01-01', to: '2030-12-31', rate: 0 })), /needs a "rate" above zero/);
  assert.throws(() => parseRates(one({ from: '2030-01-01', to: '2030-12-31', rate: '0.5' })), /needs a "rate" above zero/);
});

// Rates are quoted to the tenth of a cent. A finer one could not be printed
// as it was applied, nor priced in whole numbers.
test('a rate finer than a tenth of a cent is rejected', () => {
  const one = (rate) => JSON.stringify([{ from: '2030-01-01', to: '2030-12-31', rate }]);
  assert.throws(() => parseRates(one(0.7254)), /to the tenth of a cent at most/);
  assert.throws(() => flatRate('0.7254'), /to the tenth of a cent at most/);
  assert.equal(parseRates(one(0.725))[0].rate, 0.725);
});

test('overlapping rates are rejected, including a shared day', () => {
  assert.throws(
    () => checkRates([
      { from: '2030-01-01', to: '2030-06-30', rate: 0.5 },
      { from: '2030-06-30', to: '2030-12-31', rate: 0.6 },
    ]),
    /the rates from 2030-01-01 and from 2030-06-30 overlap/
  );
});

test('a flat rate that is not a positive number is an error', () => {
  for (const bad of ['seventy', '0', '-1', ' ', 'NaN', 'Infinity']) {
    assert.throws(() => flatRate(bad), /MILEAGE_RATE must be a number above zero/, `accepted "${bad}"`);
  }
});

// The upgrade trap: earlier versions applied MILEAGE_RATE, 0.70 by default,
// to every trip. Left in a settings file it would keep pricing 2026 at the
// 2025 rate, with nothing to say so.
test('a flat rate that disagrees with the IRS rate must be confirmed', () => {
  const stale = flatRate('0.70');
  assert.throws(
    () => rateOn('2026-09-18', stale),
    /MILEAGE_RATE=0\.7 is not the IRS business rate for 2026-09-18 \(\$0\.76\/mi\).*MILEAGE_RATE_CONFIRMED=true/
  );
  assert.throws(() => centsFor([{ miles: 10, day: '2026-03-01' }], stale), /not the IRS business rate/);
});

test('a flat rate that matches the IRS rate for the day needs no confirming', () => {
  assert.equal(rateOn('2025-06-01', flatRate('0.70')), 0.7);
});

test('a confirmed flat rate covers every date', () => {
  const own = flatRate('0.58', { confirmed: true });
  assert.equal(rateOn('2026-09-18', own), 0.58);
  assert.equal(rateOn('1999-01-01', own), 0.58);
  assert.equal(rateOn('2099-12-31', own), 0.58);
});

// With nothing to check it against, an unconfirmed rate cannot be waved
// through: 2021 was $0.56, and a leftover 0.70 would overstate it.
test('an unconfirmed flat rate is refused on dates the IRS table does not cover', () => {
  assert.throws(
    () => deductionFor(100, '2021-06-01', flatRate('0.70')),
    /MILEAGE_RATE=0\.7 cannot be checked for 2021-06-01.*MILEAGE_RATE_CONFIRMED=true/
  );
  assert.throws(() => rateOn('2099-12-31', flatRate('0.58')), /cannot be checked for 2099-12-31/);
  assert.equal(deductionFor(100, '2021-06-01', flatRate('0.56', { confirmed: true })), 56);
});

test('a flat rate wins, then a rates file, then the IRS table', () => {
  const none = './definitely-not-here.json';
  const flat = resolveRates({ flat: '0.5', confirmed: true, file: none, required: false });
  assert.equal(flat.source, 'MILEAGE_RATE');
  assert.equal(flat.rates[0].confirmed, true);
  assert.equal(resolveRates({ flat: '0.5', confirmed: false, file: none, required: false }).rates[0].confirmed, false);
  const irs = resolveRates({ flat: null, file: none, required: false });
  assert.equal(irs.source, 'IRS business rates');
  assert.deepEqual(irs.rates, [...IRS]);
  assert.equal(resolveRates({ flat: '', file: none, required: false }).source, 'IRS business rates');
});

// A mistyped path must not quietly change every deduction in the log.
test('a rates file that was configured explicitly and is missing is an error', () => {
  assert.throws(
    () => resolveRates({ flat: null, file: './definitely-not-here.json', required: true }),
    /RATES_FILE points to .*definitely-not-here\.json, which does not exist/
  );
});

// 1.4 x 0.725 is 1.015. Floating point holds it as 1.01499..., which rounds
// down; so does 0.2 x 0.725 = 0.145.
test('half a cent rounds up, whatever floating point makes of it', () => {
  assert.equal(deductionFor(1.4, '2026-06-30', IRS), 1.02);
  assert.equal(deductionFor(0.2, '2026-06-30', IRS), 0.15);
  assert.equal(deductionFor(0.6, '2026-06-30', IRS), 0.44); // 0.435
  assert.equal(deductionFor(83.6, '2026-09-18', IRS), 63.54); // 63.536
  assert.equal(deductionFor(10, '2026-03-01', IRS), 7.25);
  assert.equal(deductionFor(0, '2026-03-01', IRS), 0);
});

test('every tenth of a mile up to 200 agrees with exact arithmetic', () => {
  for (const { rate, from } of IRS) {
    const perMile = BigInt(Math.round(rate * 1000));
    for (let t = 0; t <= 2000; t++) {
      const exact = Number((BigInt(t) * perMile + 50n) / 100n);
      assert.equal(centsFor([{ miles: t / 10, day: from }], IRS), exact, `${t / 10} mi at ${rate}`);
    }
  }
});

test('miles are priced as the log shows them, to the tenth', () => {
  assert.equal(deductionFor(83.64, '2026-09-18', IRS), 63.54); // logged as 83.6
  assert.equal(deductionFor(83.66, '2026-09-18', IRS), 63.61); // logged as 83.7
  // Whatever the log prints is what is priced, on the awkward values too.
  for (const miles of [0.05, 0.25, 1.45, 2.675, 8.35, 83.65, 100.05]) {
    const shown = Number(miles.toFixed(1));
    assert.equal(deductionFor(miles, '2026-09-18', IRS), deductionFor(shown, '2026-09-18', IRS), `${miles} mi`);
  }
});

test('miles that are not a number cannot be priced', () => {
  for (const bad of [NaN, Infinity, -1, null, undefined, '10']) {
    assert.throws(() => centsFor([{ miles: bad, day: '2026-03-01' }], IRS), /cannot price/, `priced ${bad}`);
  }
});

test('legs under different rates are each priced at their own', () => {
  // Out on the last day of the old rate, home on the first day of the new one.
  const legs = [{ miles: 100, day: '2026-06-30' }, { miles: 100, day: '2026-07-01' }];
  assert.equal(centsFor(legs, IRS), 14850);
  assert.equal(centsFor([...legs].reverse(), IRS), 14850);
});

test('split legs never price more miles than the log shows for the trip', () => {
  // 1.44 + 1.44 is logged as 2.9 miles, not as 1.4 + 1.4 = 2.8.
  const legs = [{ miles: 1.44, day: '2026-06-30' }, { miles: 1.44, day: '2026-07-01' }];
  assert.equal(centsFor(legs, IRS), Math.floor((14 * 725 + 15 * 760 + 50) / 100));
  // 1.46 + 1.46 is logged as 2.9 too, not as 1.5 + 1.5 = 3.0.
  const more = [{ miles: 1.46, day: '2026-06-30' }, { miles: 1.46, day: '2026-07-01' }];
  assert.equal(centsFor(more, IRS), Math.floor((15 * 725 + 14 * 760 + 50) / 100));
});

test('rates print with two decimals, and a third only when needed', () => {
  assert.equal(formatRate(0.7), '$0.70');
  assert.equal(formatRate(0.725), '$0.725');
  assert.equal(formatRate(0.76), '$0.76');
  assert.equal(formatRate(1), '$1.00');
});

test('describes the rates a set of days was priced at', () => {
  assert.equal(describeRates([], IRS), '');
  assert.equal(describeRates(['2025-03-01', '2025-11-30'], IRS), '$0.70/mi');
  assert.equal(
    describeRates(['2026-09-18', '2026-02-01', '2026-08-01'], IRS),
    '$0.725/mi through 2026-06-30, $0.76/mi from 2026-07-01'
  );
});

// --- in the log -------------------------------------------------------------
// Times are local noon and local evening, so the day holds in any timezone.
const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`);
const trip = (id, meetingDay, outMiles, returnMiles, { outDay = meetingDay, returnDay = meetingDay } = {}) => ({
  meeting: { subject: `Meeting ${id}`, location: '123 Test St', start: at(meetingDay, 12) },
  outbound: { id, miles: outMiles, start: at(outDay, 10) },
  return: returnMiles == null ? null : { id: id + 1, miles: returnMiles, start: at(returnDay, 18) },
  confidence: 'high',
});
const column = (csv, n) => csv.trim().split('\n').slice(1).map((l) => l.split(',')[n]);
const deductions = (csv) => column(csv, 6).map(Number);

test('each row of the log carries the rate of its own date', () => {
  const entries = [trip(1, '2026-03-10', 10, 10), trip(3, '2026-09-10', 10, 10)];
  assert.deepEqual(deductions(toCsv(entries, { rates: IRS })), [14.5, 15.2]);
});

// The rate follows the drive, not the meeting it was for.
test('a drive home after the rate changed is priced at the new rate', () => {
  const entries = [trip(1, '2026-06-30', 100, 100, { returnDay: '2026-07-01' })];
  const csv = toCsv(entries, { rates: IRS });
  assert.deepEqual(column(csv, 0), ['2026-06-30']);
  assert.deepEqual(deductions(csv), [148.5]);
  assert.equal(summarize(entries, { rates: IRS }).deduction, 148.5);
});

test('a drive out the evening before is priced at the rate of that evening', () => {
  const july = [trip(1, '2026-07-01', 100, 100, { outDay: '2026-06-30' })];
  assert.deepEqual(deductions(toCsv(july, { rates: IRS })), [148.5]);
  const newYear = [trip(3, '2026-01-01', 100, 100, { outDay: '2025-12-31' })];
  assert.deepEqual(deductions(toCsv(newYear, { rates: IRS })), [142.5]);
});

test('a drive with no start time cannot be priced', () => {
  const broken = trip(7, '2026-03-10', 10, 10);
  delete broken.return.start;
  assert.throws(() => tripLegs(broken), /drive #8 has no start time/);
  assert.throws(() => toCsv([broken], { rates: IRS }), /drive #8 has no start time/);
});

test('the total is the sum of the rows, to the cent', () => {
  // Three trips whose unrounded deductions sum to a different cent than the rows do.
  const entries = [1, 3, 5].map((id) => trip(id, '2026-03-10', 0.7, null));
  assert.deepEqual(deductions(toCsv(entries, { rates: IRS })), [0.51, 0.51, 0.51]);
  const s = summarize(entries, { rates: IRS });
  assert.equal(s.deduction, 1.53);
  assert.equal(s.trips, 3);
  assert.equal(s.totalMiles, 2.1);
});

test('the miles total is the sum of the rows as shown', () => {
  // Two trips of 1.44 miles are each logged as 1.4: 2.8 in all, not 2.9.
  const entries = [trip(1, '2026-03-10', 1.44, null), trip(3, '2026-03-11', 1.44, null)];
  assert.deepEqual(column(toCsv(entries, { rates: IRS }), 5), ['1.4', '1.4']);
  assert.equal(summarize(entries, { rates: IRS }).totalMiles, 2.8);
});

test('a row can be recomputed from the miles it shows', () => {
  const csv = toCsv([trip(1, '2026-09-18', 41.83, 41.81)], { rates: IRS });
  const [total] = column(csv, 5);
  assert.equal(total, '83.6');
  assert.deepEqual(deductions(csv), [63.54]); // 83.6 x 0.76 = 63.536
});

test('a trip on a date no rate covers stops the log from being written', () => {
  const entries = [trip(1, '2099-03-10', 10, 10)];
  assert.throws(() => toCsv(entries, { rates: IRS }), /no mileage rate covers 2099-03-10/);
  assert.throws(() => summarize(entries, { rates: IRS }), /no mileage rate covers 2099-03-10/);
});

test('an unconfirmed stale flat rate stops the log from being written', () => {
  const entries = [trip(1, '2026-09-10', 10, 10)];
  assert.throws(() => toCsv(entries, { rates: flatRate('0.70') }), /not the IRS business rate for 2026-09-10/);
  assert.deepEqual(deductions(toCsv(entries, { rates: flatRate('0.70', { confirmed: true }) })), [14]);
});

test('with no rates given the log uses the IRS table', () => {
  const entries = [trip(1, '2025-03-10', 10, null)];
  assert.deepEqual(deductions(toCsv(entries)), [7]);
  assert.equal(summarize(entries).deduction, 7);
});
