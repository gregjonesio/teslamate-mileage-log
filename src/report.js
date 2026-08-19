import { localDateString } from './dates.js';

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render matched entries as an IRS-style mileage log CSV.
 * Columns: date, purpose (meeting subject), destination, out/return/total miles,
 * confidence, deduction at the configured rate, and drive ids for auditability.
 */
export function toCsv(entries, { mileageRate = 0.7 } = {}) {
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
    const total = out + ret;
    return [
      localDateString(e.meeting.start),
      e.meeting.subject,
      e.destination ?? e.meeting.location,
      out.toFixed(1),
      e.return ? ret.toFixed(1) : '',
      total.toFixed(1),
      (total * mileageRate).toFixed(2),
      e.confidence,
      e.return ? `${e.outbound.id}+${e.return.id}` : String(e.outbound.id),
    ];
  });
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

export function summarize(entries, { mileageRate = 0.7 } = {}) {
  const totalMiles = entries.reduce(
    (sum, e) => sum + e.outbound.miles + (e.return ? e.return.miles : 0),
    0
  );
  return {
    trips: entries.length,
    totalMiles,
    deduction: totalMiles * mileageRate,
  };
}
