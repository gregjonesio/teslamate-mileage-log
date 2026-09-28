import { localDateString } from './dates.js';
import { IRS_BUSINESS_RATES, centsFor, tenths } from './rates.js';

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The drives of a trip, each with the day it was driven. That day, not the
 * day of the meeting, decides the rate: a drive home after midnight, or the
 * evening before an early meeting, can fall under a different one.
 */
export function tripLegs(entry) {
  return [entry.outbound, entry.return].filter(Boolean).map((drive) => {
    if (!(drive.start instanceof Date) || Number.isNaN(drive.start.getTime())) {
      throw new Error(`drive #${drive.id} has no start time, so its miles cannot be priced`);
    }
    return { miles: drive.miles, day: localDateString(drive.start) };
  });
}

const tripMiles = (e) => e.outbound.miles + (e.return ? e.return.miles : 0);

/**
 * Render matched entries as an IRS-style mileage log CSV.
 * Columns: date, purpose (meeting subject), destination, out/return/total miles,
 * deduction at the rate for the day each leg was driven, confidence, and drive
 * ids for auditability.
 */
export function toCsv(entries, { rates = IRS_BUSINESS_RATES } = {}) {
  const header = [
    'date',
    'purpose',
    'destination',
    'outbound_miles',
    'return_miles',
    'total_miles',
    'deduction',
    'confidence',
    'drive_ids',
  ];
  const rows = entries.map((e) => {
    const out = e.outbound.miles;
    const ret = e.return ? e.return.miles : 0;
    return [
      localDateString(e.meeting.start),
      e.meeting.subject,
      e.destination ?? e.meeting.location,
      out.toFixed(1),
      e.return ? ret.toFixed(1) : '',
      (out + ret).toFixed(1),
      (centsFor(tripLegs(e), rates) / 100).toFixed(2),
      e.confidence,
      e.return ? `${e.outbound.id}+${e.return.id}` : String(e.outbound.id),
    ];
  });
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

/**
 * Totals. Both are the sum of the rows as the CSV shows them, miles to the
 * tenth and deductions to the cent, so they tie to it exactly.
 */
export function summarize(entries, { rates = IRS_BUSINESS_RATES } = {}) {
  return {
    trips: entries.length,
    totalMiles: entries.reduce((sum, e) => sum + tenths(tripMiles(e)), 0) / 10,
    deduction: entries.reduce((sum, e) => sum + centsFor(tripLegs(e), rates), 0) / 100,
  };
}
