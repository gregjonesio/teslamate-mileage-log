const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight starting the given YYYY-MM-DD calendar day. */
function localMidnight(str, flag) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) {
    throw new Error(`${flag} must be a date in YYYY-MM-DD form (got "${str}")`);
  }
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error(`${flag} is not a real date: ${str}`);
  }
  return dt;
}

/**
 * Turn --from/--to into a half-open instant range [from, to).
 *
 * Both flags name LOCAL calendar days and --to is INCLUSIVE, because that is
 * what a mileage log is kept in. Boundaries are local midnights, not UTC ones:
 * a 6pm drive in California is already the next day in UTC, and UTC boundaries
 * dropped those drives from the window without saying so.
 */
export function parseDateRange(fromStr, toStr) {
  const from = localMidnight(fromStr, '--from');
  const lastDay = localMidnight(toStr, '--to');
  if (lastDay < from) {
    throw new Error(`--to (${toStr}) is before --from (${fromStr})`);
  }
  const to = new Date(lastDay);
  to.setDate(to.getDate() + 1); // field-based, so it survives DST transitions
  return { from, to };
}

/** YYYY-MM-DD for the local calendar day an instant falls on. */
export function localDateString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM-DD HH:MM for the local calendar day and time an instant falls on. */
export function localDateTimeString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${localDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
