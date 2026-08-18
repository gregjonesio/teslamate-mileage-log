import { PublicClientApplication } from '@azure/msal-node';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, requireConfig, dataDir } from './config.js';

const SCOPES = ['Calendars.Read'];
const cachePath = path.join(dataDir, 'msal-cache.json');

const cachePlugin = {
  beforeCacheAccess: async (ctx) => {
    if (existsSync(cachePath)) ctx.tokenCache.deserialize(readFileSync(cachePath, 'utf8'));
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) writeFileSync(cachePath, ctx.tokenCache.serialize());
  },
};

function app() {
  requireConfig(['graphClientId']);
  return new PublicClientApplication({
    auth: {
      clientId: config.graphClientId,
      authority: `https://login.microsoftonline.com/${config.graphTenantId}`,
    },
    cache: { cachePlugin },
  });
}

export async function getToken({ interactive = false } = {}) {
  const pca = app();
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
      return result.accessToken;
    } catch {
      // fall through to device code
    }
  }
  if (!interactive) {
    throw new Error('Not signed in. Run: mileage auth');
  }
  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (info) => console.log(info.message),
  });
  return result.accessToken;
}

/**
 * Fetch calendar events (UTC) in [fromDate, toDate) that have a physical location.
 * Events whose location looks like a meeting URL are skipped.
 */
export async function fetchMeetings(fromDate, toDate) {
  const token = await getToken();
  const meetings = [];
  let url =
    `https://graph.microsoft.com/v1.0/me/calendarView` +
    `?startDateTime=${fromDate.toISOString()}&endDateTime=${toDate.toISOString()}` +
    `&$select=id,subject,location,start,end&$top=100`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) throw new Error(`Graph error ${res.status}: ${await res.text()}`);
    const body = await res.json();
    for (const ev of body.value) {
      const loc = ev.location?.displayName?.trim() || '';
      if (!loc || isVirtual(loc)) continue;
      meetings.push({
        id: ev.id,
        subject: ev.subject || '(no subject)',
        location: loc,
        start: new Date(ev.start.dateTime + 'Z'),
        end: new Date(ev.end.dateTime + 'Z'),
      });
    }
    url = body['@odata.nextLink'] || null;
  }
  return meetings;
}

const VIRTUAL_PATTERNS = [/^https?:\/\//i, /zoom\.us/i, /teams\.microsoft/i, /meet\.google/i, /webex/i, /^microsoft teams/i];

export function isVirtual(location) {
  return VIRTUAL_PATTERNS.some((p) => p.test(location));
}
