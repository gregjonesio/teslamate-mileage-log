import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

/**
 * Mileage rates by date. A rate belongs to the day the miles were driven: the
 * IRS changes it every year and sometimes in the middle of one, so a single
 * number applied to a whole log misprices part of it without any error.
 *
 * Which rates apply, first that is set:
 *   - MILEAGE_RATE, one flat rate for every date (an employer's reimbursement
 *     rate, a non-US rate),
 *   - rates.json, your own dated table,
 *   - the IRS business rates below.
 * Miles driven on a date no rate covers stop the run rather than borrow a rate.
 *
 * How a deduction is calculated, so that it can be checked by hand from the
 * log: miles as logged (to the tenth of a mile) times the rate for the day
 * they were driven, rounded to the cent, half a cent rounding up. The
 * arithmetic is done in whole numbers; 1.4 miles at $0.725 is $1.015, which
 * floating point holds as a hair less and would round down.
 */

/**
 * IRS standard mileage rates for business use, dollars per mile.
 * Source: https://www.irs.gov/tax-professionals/standard-mileage-rates
 * Add each new year when the IRS announces it, usually in December, and any
 * mid-year revision (2022 and 2026 each had one) when it is announced.
 */
export const IRS_BUSINESS_RATES = Object.freeze([
  { from: '2022-01-01', to: '2022-06-30', rate: 0.585 },
  { from: '2022-07-01', to: '2022-12-31', rate: 0.625 },
  { from: '2023-01-01', to: '2023-12-31', rate: 0.655 },
  { from: '2024-01-01', to: '2024-12-31', rate: 0.67 },
  { from: '2025-01-01', to: '2025-12-31', rate: 0.7 },
  { from: '2026-01-01', to: '2026-06-30', rate: 0.725 },
  { from: '2026-07-01', to: '2026-12-31', rate: 0.76 },
].map(Object.freeze));

const isDay = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** A rate in tenths of a cent, which is as fine as rates are quoted. */
const mills = (rate) => Math.round(rate * 1000);
const isRate = (n) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.abs(n * 1000 - mills(n)) < 1e-6;
/**
 * Miles as logged: to the tenth, by the same rounding that prints them, so
 * the miles priced are always the miles shown.
 */
export const tenths = (miles) => Math.round(Number(miles.toFixed(1)) * 10);

/**
 * Validate a rate table: a list of { from, to, rate } with YYYY-MM-DD days,
 * both inclusive. Throws with the offending entry named. Returns the entries
 * in date order.
 */
export function checkRates(raw, source = 'rates') {
  if (!Array.isArray(raw)) throw new Error(`${source} must contain a JSON array of rates`);
  if (!raw.length) throw new Error(`${source} lists no rates`);
  const rates = raw.map((r, i) => {
    const where = `${source} entry ${i + 1}`;
    if (!r || typeof r !== 'object') throw new Error(`${where} must be an object`);
    if (!isDay(r.from)) throw new Error(`${where} needs a "from" date in YYYY-MM-DD form`);
    if (!isDay(r.to)) throw new Error(`${where} needs a "to" date in YYYY-MM-DD form`);
    if (r.to < r.from) throw new Error(`${where} ends (${r.to}) before it starts (${r.from})`);
    if (!isRate(r.rate)) {
      throw new Error(`${where} needs a "rate" above zero, in dollars per mile, to the tenth of a cent at most`);
    }
    return { from: r.from, to: r.to, rate: r.rate };
  });
  rates.sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < rates.length; i++) {
    if (rates[i].from <= rates[i - 1].to) {
      throw new Error(`${source}: the rates from ${rates[i - 1].from} and from ${rates[i].from} overlap`);
    }
  }
  return rates;
}

/** Parse a rate table from JSON text. */
export function parseRates(json, source = 'rates file') {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  return checkRates(raw, source);
}

/**
 * One rate for every date. Unless it is confirmed, it may not disagree with
 * the IRS rate for a day it prices: see rateEntryOn.
 */
export function flatRate(value, { confirmed = false, source = 'MILEAGE_RATE' } = {}) {
  const rate = typeof value === 'number' ? value : Number(String(value).trim() || NaN);
  if (!isRate(rate)) {
    throw new Error(
      `${source} must be a number above zero, in dollars per mile, to the tenth of a cent at most (got "${value}")`
    );
  }
  return [{ from: '0001-01-01', to: '9999-12-31', rate, flat: true, confirmed: Boolean(confirmed) }];
}

/**
 * The rates in force for this run, and where they came from. A RATES_FILE
 * that is set but missing is an error rather than a fall back to the IRS
 * table: a mistyped path must not quietly change every deduction.
 */
export function resolveRates({
  flat = config.mileageRate,
  confirmed = config.mileageRateConfirmed,
  file = config.ratesFile,
  required = Boolean(process.env.RATES_FILE),
} = {}) {
  if (flat !== null && flat !== undefined && flat !== '') {
    return { rates: flatRate(flat, { confirmed }), source: 'MILEAGE_RATE' };
  }
  if (file && existsSync(file)) {
    return { rates: parseRates(readFileSync(file, 'utf8'), file), source: file };
  }
  if (file && required) throw new Error(`RATES_FILE points to ${file}, which does not exist`);
  return { rates: [...IRS_BUSINESS_RATES], source: 'IRS business rates' };
}

/** "$0.70", "$0.725": at least two decimals, a third only when it is needed. */
export const formatRate = (rate) => `$${rate.toFixed(3).replace(/0$/, '')}`;

/**
 * The entry covering a YYYY-MM-DD day. Throws when none does.
 *
 * Also throws when a flat rate has not been confirmed and either disagrees
 * with the IRS rate for that day or falls on a day the IRS table does not
 * cover. Earlier versions applied MILEAGE_RATE, 0.70 by default, to every
 * trip; left in place it would go on pricing every year at a rate the IRS has
 * since changed, which is the defect this module fixes.
 */
export function rateEntryOn(day, rates) {
  if (!isDay(day)) throw new Error(`cannot price miles dated "${day}"`);
  const entry = rates.find((r) => r.from <= day && day <= r.to);
  if (!entry) {
    throw new Error(
      `no mileage rate covers ${day}: add it to rates.json, or set MILEAGE_RATE to use one rate for every date`
    );
  }
  if (entry.flat && !entry.confirmed) {
    const irs = IRS_BUSINESS_RATES.find((r) => r.from <= day && day <= r.to);
    const keep = 'set MILEAGE_RATE_CONFIRMED=true to keep your own rate';
    if (!irs) {
      // Nothing to check it against, so it cannot be waved through either.
      throw new Error(
        `MILEAGE_RATE=${entry.rate} cannot be checked for ${day}, a date the built-in IRS rates do not cover. ` +
          `Remove MILEAGE_RATE and list your rates in rates.json, or ${keep}`
      );
    }
    if (mills(irs.rate) !== mills(entry.rate)) {
      throw new Error(
        `MILEAGE_RATE=${entry.rate} is not the IRS business rate for ${day} (${formatRate(irs.rate)}/mi). ` +
          `Remove MILEAGE_RATE to use the IRS rates, or ${keep}`
      );
    }
  }
  return entry;
}

/** Dollars per mile on a YYYY-MM-DD day. */
export const rateOn = (day, rates) => rateEntryOn(day, rates).rate;

/**
 * Whole cents for a trip given as legs, each { miles, day } with the day it
 * was driven. The legs are priced on the miles the log shows for the trip
 * (the total to the tenth); when they fall under different rates the last
 * leg takes whatever the rounding of the others left. Rounded once, at the end.
 */
export function centsFor(legs, rates) {
  for (const leg of legs) {
    if (typeof leg.miles !== 'number' || !Number.isFinite(leg.miles) || leg.miles < 0) {
      throw new Error(`cannot price ${leg.miles} miles on ${leg.day}`);
    }
  }
  let left = tenths(legs.reduce((sum, leg) => sum + leg.miles, 0));
  let units = 0; // ten-thousandths of a dollar: tenths of a mile times tenths of a cent
  legs.forEach((leg, i) => {
    const share = i === legs.length - 1 ? left : Math.min(left, tenths(leg.miles));
    left -= share;
    units += share * mills(rateOn(leg.day, rates));
  });
  return Math.floor((units + 50) / 100);
}

/** Deduction in dollars for miles driven on one day. */
export const deductionFor = (miles, day, rates) => centsFor([{ miles, day }], rates) / 100;

/**
 * The rates a set of days was priced at, as a phrase: "$0.70/mi", or
 * "$0.725/mi through 2026-06-30, $0.76/mi from 2026-07-01".
 */
export function describeRates(days, rates) {
  const used = [...new Set(days.map((d) => rateEntryOn(d, rates)))].sort((a, b) => a.from.localeCompare(b.from));
  if (!used.length) return '';
  if (used.length === 1) return `${formatRate(used[0].rate)}/mi`;
  return used
    .map((r, i) => `${formatRate(r.rate)}/mi ${i < used.length - 1 ? `through ${r.to}` : `from ${r.from}`}`)
    .join(', ');
}
