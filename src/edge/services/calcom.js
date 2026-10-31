// Cal.com calendar adapter (API-key connection, called straight from the worker).
//
// The customer's Cal.com API key + chosen event type are stored by knoxified-auth
// (oauth_connections, provider 'calcom'); this module fetches them once per call
// and talks to Cal.com API v2. Every function returns plain data and never throws,
// so a Cal.com outage can't crash a call: the tools turn failures into a polite
// "the team will follow up" instruction.

const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSION = '2024-08-13';
const AUTH_SERVICE_URL_DEFAULT = 'https://oauth.knoxified.org';
const TIMEOUT_MS = 10000;

// ---- connection (key + event type) -----------------------------------------

export async function getConnection(session) {
  if (session._calcom) return session._calcom;
  const env = session.env;
  const headers = { 'Content-Type': 'application/json' };
  if (env.INTERNAL_API_KEY) headers['x-internal-key'] = env.INTERNAL_API_KEY;

  let res;
  try {
    res = await fetch(`${env.AUTH_SERVICE_URL || AUTH_SERVICE_URL_DEFAULT}/auth/calcom/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: session.userId }),
    });
  } catch (err) {
    console.error('[Cal.com] could not reach the auth service:', err.message);
    return { ok: false, error: 'auth_unreachable' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) return { ok: false, error: 'not_connected' };
  if (!res.ok || !data.accessToken) {
    console.error(`[Cal.com] token fetch failed: HTTP ${res.status} ${data.error || ''}`);
    return { ok: false, error: 'auth_failed' };
  }
  const eventTypeId = data.metadata?.eventTypeId;
  if (!eventTypeId) return { ok: false, error: 'no_event_type' };

  session._calcom = {
    ok: true,
    apiKey: data.accessToken,
    eventTypeId,
    lengthMinutes: Number(data.metadata?.lengthMinutes) || 30,
  };
  return session._calcom;
}

// ---- low level request ------------------------------------------------------

async function request(conn, method, path, { query, body } = {}) {
  const url = new URL(`${CAL_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        'cal-api-version': CAL_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    console.log(`[Cal.com] ${method} ${path} -> HTTP ${res.status}${res.ok ? '' : ' | ' + text.slice(0, 300)}`);
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    console.error(`[Cal.com] ${method} ${path} failed:`, err.message);
    return { ok: false, status: 0, json: null, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

function localDate(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

const SLOT_TAKEN_RE = /no.?available|not available|unavailable|already|booked|busy|conflict|taken/i;

// ---- availability -----------------------------------------------------------

// Open start times (epoch ms) on one local day. startIso/endIso are the UTC instants of
// that day's first and last minute in the business timezone (computed by the caller).
export async function fetchSlots(session, { date, tz, startIso, endIso }) {
  const conn = await getConnection(session);
  if (!conn.ok) return conn;
  const r = await request(conn, 'GET', '/slots', {
    query: { eventTypeId: conn.eventTypeId, startTime: startIso, endTime: endIso, timeZone: tz },
  });
  if (!r.ok) return { ok: false, error: 'lookup_failed' };

  // Documented shape: data.slots = { "YYYY-MM-DD": [{ time }] }. Tolerate { "YYYY-MM-DD": [{ start }] } too.
  const days = r.json?.data?.slots || r.json?.data || {};
  const now = Date.now();
  const starts = Object.values(days)
    .flat()
    .map((s) => Date.parse(typeof s === 'string' ? s : s?.time || s?.start))
    .filter((ms) => Number.isFinite(ms) && ms > now + 5 * 60000 && localDate(ms, tz) === date);
  return { ok: true, starts, durationMinutes: conn.lengthMinutes };
}

// ---- booking ---------------------------------------------------------------

export async function bookSlot(session, { startMs, name, email, phone, notes, tz }) {
  const conn = await getConnection(session);
  if (!conn.ok) return conn;

  const attendee = { name, email, timeZone: tz };
  if (phone && /^\+\d{7,15}$/.test(phone)) attendee.phoneNumber = phone;
  const base = {
    start: new Date(startMs).toISOString(),
    eventTypeId: conn.eventTypeId,
    attendee,
    metadata: { source: 'knoxified-voice' },
  };

  // The reason goes in the standard "notes" booking field. If the event type rejects it
  // (custom setup), retry once without so the caller still gets booked.
  let r = await request(conn, 'POST', '/bookings', { body: { ...base, bookingFieldsResponses: notes ? { notes } : undefined } });
  if (!r.ok && r.status === 400 && !SLOT_TAKEN_RE.test(r.text)) {
    r = await request(conn, 'POST', '/bookings', { body: base });
  }
  if (r.ok && r.json?.data?.uid) {
    return {
      ok: true,
      uid: r.json.data.uid,
      pending: r.json.data.status === 'pending',
      durationMinutes: conn.lengthMinutes,
    };
  }
  if (r.status === 409 || SLOT_TAKEN_RE.test(r.text)) return { ok: false, error: 'slot_taken' };
  return { ok: false, error: 'booking_failed' };
}

// ---- find / reschedule / cancel --------------------------------------------

// Upcoming bookings on THIS event type for an attendee email, soonest first.
export async function findBookings(session, { email }) {
  const conn = await getConnection(session);
  if (!conn.ok) return conn;
  const r = await request(conn, 'GET', '/bookings', {
    query: { attendeeEmail: email, status: 'upcoming', sortStart: 'asc', take: 20 },
  });
  if (!r.ok) return { ok: false, error: 'lookup_failed' };
  const rows = Array.isArray(r.json?.data) ? r.json.data : [];
  const bookings = rows
    .filter((b) => b?.uid && b.status !== 'cancelled' && b.status !== 'rejected')
    .filter((b) => {
      const et = b.eventTypeId ?? b.eventType?.id;
      return et == null || String(et) === String(conn.eventTypeId);
    })
    .map((b) => ({
      uid: b.uid,
      startMs: Date.parse(b.start),
      attendees: Array.isArray(b.attendees) ? b.attendees : [],
    }))
    .filter((b) => Number.isFinite(b.startMs));
  return { ok: true, bookings };
}

export async function rescheduleBooking(session, { uid, startMs, email }) {
  const conn = await getConnection(session);
  if (!conn.ok) return conn;
  const r = await request(conn, 'POST', `/bookings/${encodeURIComponent(uid)}/reschedule`, {
    body: { start: new Date(startMs).toISOString(), rescheduledBy: email, reschedulingReason: 'Changed by the caller on a phone call' },
  });
  if (r.ok) return { ok: true, uid: r.json?.data?.uid || uid, pending: r.json?.data?.status === 'pending' };
  if (r.status === 409 || SLOT_TAKEN_RE.test(r.text)) return { ok: false, error: 'slot_taken' };
  return { ok: false, error: 'booking_failed' };
}

export async function cancelBooking(session, { uid, reason }) {
  const conn = await getConnection(session);
  if (!conn.ok) return conn;
  const r = await request(conn, 'POST', `/bookings/${encodeURIComponent(uid)}/cancel`, {
    body: { cancellationReason: (reason || 'Cancelled by the caller on a phone call').slice(0, 200) },
  });
  return r.ok ? { ok: true } : { ok: false, error: 'booking_failed' };
}
