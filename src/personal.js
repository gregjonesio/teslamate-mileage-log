import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

/**
 * Personal events: calendar entries with a physical location that are not
 * business. The matcher cannot tell a client lunch from a school pickup; both
 * are an event with an address, and a drive that ends there is logged with
 * high confidence. Left alone, personal miles enter a business log silently.
 *
 * An event is personal when any of these holds:
 *   - Outlook marks it so (sensitivity "personal"),
 *   - its subject contains the marker (PERSONAL_MARKER, default "(personal)"),
 *   - its subject contains a term listed in personal.json, as a whole word.
 */

/** Validate personal terms. Throws with the offending entry named. */
export function parsePersonalTerms(json, source = 'personal file') {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${source} must contain a JSON array of terms`);
  const seen = new Set();
  return raw.map((t, i) => {
    const where = `${source} entry ${i + 1}`;
    if (typeof t !== 'string' || !t.trim()) {
      throw new Error(`${where} must be a non-empty string`);
    }
    const term = t.trim().normalize('NFC');
    const key = term.toLowerCase();
    if (seen.has(key)) throw new Error(`${where} lists "${term}" more than once`);
    seen.add(key);
    return term;
  });
}

/**
 * Load terms from PERSONAL_FILE (default personal.json). No file means no
 * terms, unless the path was set explicitly: a mistyped PERSONAL_FILE would
 * otherwise switch the terms off and let personal miles back into the log.
 */
export function loadPersonalTerms(
  file = config.personalFile,
  { required = Boolean(process.env.PERSONAL_FILE) } = {}
) {
  if (!file || !existsSync(file)) {
    if (file && required) throw new Error(`PERSONAL_FILE points to ${file}, which does not exist`);
    return [];
  }
  return parsePersonalTerms(readFileSync(file, 'utf8'), file);
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive, and the term must not touch a letter, digit or accent on
 * either side. "Sam" matches "Sam dentist", "Pick up Sam" and "Sam's recital",
 * never "Samsung demo": a short name must not swallow a business subject.
 * Both sides are normalised so an accented term matches however it was typed.
 */
function containsTerm(subject, term) {
  const edge = '[\\p{L}\\p{N}\\p{M}]';
  const pattern = `(?<!${edge})${escapeRegex(term.normalize('NFC'))}(?!${edge})`;
  return new RegExp(pattern, 'iu').test(subject.normalize('NFC'));
}

/**
 * Why a meeting is personal, as a short phrase for the report, or null when
 * no personal rule matches. The reason is always shown so a wrong rule is
 * easy to spot.
 */
export function personalReason(meeting, { terms = [], marker = '' } = {}) {
  if (String(meeting.sensitivity || '').toLowerCase() === 'personal') {
    return 'marked personal in Outlook';
  }
  const subject = String(meeting.subject || '');
  const m = String(marker ?? '').trim();
  if (m && subject.toLowerCase().includes(m.toLowerCase())) {
    return `subject contains "${m}"`;
  }
  const term = terms.find((t) => containsTerm(subject, t));
  return term ? `personal term "${term}"` : null;
}

/**
 * Separate the meetings a personal rule caught from the rest. The personal
 * ones come back with their reason rather than being dropped, so the caller
 * can list them. This keeps a personal event from claiming a drive; it does
 * not reserve the drive, which another meeting at the same place may claim.
 */
export function splitPersonal(meetings, rules = {}) {
  const business = [];
  const personal = [];
  for (const meeting of meetings) {
    const reason = personalReason(meeting, rules);
    if (reason) personal.push({ meeting, reason });
    else business.push(meeting);
  }
  return { business, personal };
}
