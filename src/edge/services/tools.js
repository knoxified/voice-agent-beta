// LLM tools the voice agent can call mid-conversation. These replace the old
// keyword-regex intent trigger: the model decides WHEN (guided by the prompt),
// but this module decides whether a call is actually allowed to reach the
// AppointMate webhook. Every webhook call costs the account credits, so the
// guard here is deliberately strict and independent of the model.

import { triggerAutomation } from './n8n.js';

const MAX_AVAILABILITY_CHECKS = 4; // per call (1 credit each)
const MAX_BOOKINGS = 2; // per call (2 credits each)
const MAX_DAYS_AHEAD = 120;

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        'Look up open appointment times on ONE day. Use only after the caller has agreed to come in / be set up with the team and you know roughly which day suits them. Costs credits, so do not call it speculatively or to browse.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The day to check as YYYY-MM-DD, copied from the "Upcoming days" list in your instructions (never work out dates yourself).' },
          duration_minutes: { type: 'integer', description: 'Length of the appointment in minutes. Default 30.' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Book the appointment. Call this ONLY after ALL of these are true: the caller is a genuine fit and agreed to come in, they chose a time that check_availability returned, you collected their full name and email, and you READ BOTH BACK letter by letter and the caller said yes. If anything is missing, keep collecting it instead of calling this. A phone number is optional and must never be requested.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Caller's full name, exactly as confirmed." },
          email: { type: 'string', description: "Caller's email address, exactly as confirmed letter by letter." },
          date: { type: 'string', description: 'Appointment day, YYYY-MM-DD, from the Upcoming days list.' },
          time: { type: 'string', description: 'Appointment start time, 24-hour HH:MM, one of the times check_availability returned.' },
          reason: { type: 'string', description: 'One short sentence on the main reason for the call and visit, from what the caller told you (for example "Itchy fluid-filled bumps on hand for about 5 days"). Under 100 characters.' },
          details_confirmed: { type: 'boolean', description: 'true ONLY if you read the name and email back letter by letter and the caller confirmed they are correct.' },
          phone: { type: 'string', description: 'Optional. Only if the caller volunteered a number.' },
          duration_minutes: { type: 'integer', description: 'Length in minutes. Default 30.' },
        },
        required: ['name', 'email', 'date', 'time', 'reason', 'details_confirmed'],
      },
    },
  },
];

export function businessTimeZone(session) {
  return session.agentConfig?.timezone || session.env?.DEFAULT_TIMEZONE || 'Africa/Lagos';
}

// ---- timezone helpers (no libraries; Workers has Intl) ----------------------

function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Local wall-clock time in `timeZone` -> { instant: Date, offset: '+01:00' }
function localToInstant(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let off = tzOffsetMinutes(new Date(guess), timeZone);
  let instant = new Date(guess - off * 60000);
  const off2 = tzOffsetMinutes(instant, timeZone); // DST edge correction
  if (off2 !== off) {
    off = off2;
    instant = new Date(guess - off * 60000);
  }
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { instant, offset };
}

export function todayInZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanDuration(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30;
  return Math.min(240, Math.max(15, Math.round(n)));
}

function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---- n8n response interpretation -------------------------------------------

function isInsufficientCredits(res) {
  return typeof res?.message === 'string' && res.message.toUpperCase().includes('INSUFFICIENT CREDITS');
}

// ---- executor ---------------------------------------------------------------

export async function executeTool(session, call) {
  const name = call.function?.name;
  let args = {};
  try {
    args = JSON.parse(call.function?.arguments || '{}');
  } catch {
    return { ok: false, error: 'bad_arguments', instruction: 'Ask the caller to repeat the details, then try again.' };
  }

  if (name === 'check_availability') return runAvailability(session, args);
  if (name === 'book_appointment') return runBooking(session, args);
  return { ok: false, error: 'unknown_tool' };
}

async function runAvailability(session, args) {
  const tz = businessTimeZone(session);
  const date = String(args.date || '').trim();

  if (!isRealDate(date)) {
    return { ok: false, error: 'invalid_date', instruction: 'Confirm which day the caller means, then try again.' };
  }
  if (date < todayInZone(tz)) {
    return { ok: false, error: 'date_in_past', instruction: 'That day has passed. Ask for an upcoming day.' };
  }
  const cached = session.availabilityCache.get(date);
  if (cached) return cached; // same day already looked up on this call: no extra credit
  if (session.availabilityChecks >= MAX_AVAILABILITY_CHECKS) {
    return { ok: false, error: 'limit_reached', instruction: 'Do not check again. Offer to have the team follow up with times instead.' };
  }
  session.availabilityChecks += 1;

  const duration = cleanDuration(args.duration_minutes);
  const res = await triggerAutomation(session.env, 'check_availability', {
    userId: session.userId,
    provider: 'google',
    tool: 'checkAvailableSlot',
    date,
    duration,
    timeZone: tz,
  });

  if (isInsufficientCredits(res)) {
    return { ok: false, error: 'service_unavailable', instruction: 'Scheduling is not available right now. Offer to take a message so the team can follow up.' };
  }
  if (!res || res.available !== true) {
    return { ok: false, error: 'lookup_failed', instruction: 'You could not reach the calendar. Offer to take a message so the team can follow up.' };
  }

  // Build the spoken times ourselves from the real slot instants, in the
  // business timezone. n8n's own text summary is not trusted for display.
  const starts = (Array.isArray(res.freeSlots) ? res.freeSlots : [])
    .map((sl) => Date.parse(sl.start))
    .filter(Number.isFinite);
  session.availabilitySlots.set(date, new Set(starts));
  const labels = spreadLabels(starts, tz, 6);
  const summary = starts.length
    ? `Open times on ${date} (${tz}): ${labels.join(', ')}`
    : `No openings on ${date}`;
  session.availabilityNotes.push({ date, summary });
  const result = {
    ok: true,
    date,
    timezone: tz,
    openTimes: labels,
    hasOpenings: starts.length > 0,
    instruction: starts.length
      ? 'Offer two or three of these times naturally (for example "I have 10 or 2:30"). Never read the whole list.'
      : 'Nothing is open that day. Offer another day.',
  };
  session.availabilityCache.set(date, result);
  return result;
}

async function runBooking(session, args) {
  const tz = businessTimeZone(session);
  const name = String(args.name || '').trim();
  const email = String(args.email || '').trim().toLowerCase();
  const date = String(args.date || '').trim();
  const time = String(args.time || '').trim();
  const phone = String(args.phone || '').trim() || session.callerNumber || ''; // optional
  const reasonText = String(args.reason || '').trim();

  const missing = [];
  if (name.length < 2) missing.push('full name');
  if (!EMAIL_RE.test(email)) missing.push('a valid email address');
  if (!isRealDate(date) || !TIME_RE.test(time)) missing.push('a specific day and time');
  if (reasonText.length < 3) missing.push('the main reason for the visit');
  if (missing.length) {
    return { ok: false, error: 'missing_details', missing, instruction: `Do not book yet. Naturally ask the caller for: ${missing.join(', ')}.` };
  }

  if (args.details_confirmed !== true) {
    return {
      ok: false,
      error: 'details_not_confirmed',
      instruction: 'Do not book yet. Read the full name and the email back to the caller letter by letter (for example K-N-O-X, F-A-V-O-R at gmail dot com), ask if both are correct, fix anything wrong, and only call this again once they say yes.',
    };
  }

  if (session.bookingsMade >= MAX_BOOKINGS) {
    return { ok: false, error: 'limit_reached', instruction: 'A booking was already made on this call. Do not book again.' };
  }

  const duration = cleanDuration(args.duration_minutes);
  const { instant, offset } = localToInstant(date, time, tz);
  const now = Date.now();
  if (instant.getTime() < now + 5 * 60000) {
    return { ok: false, error: 'time_in_past', instruction: 'That time has already passed. Ask for an upcoming time.' };
  }
  if (instant.getTime() > now + MAX_DAYS_AHEAD * 86400000) {
    return { ok: false, error: 'too_far_ahead', instruction: 'That is too far ahead to book. Ask for a nearer date.' };
  }

  // The caller must be booked into a time that was really open: availability
  // for that day must have been checked, and the exact slot must be in it.
  const openSlots = session.availabilitySlots.get(date);
  if (!openSlots) {
    return { ok: false, error: 'availability_not_checked', instruction: 'Check availability for that day with check_availability first, then offer real open times.' };
  }
  if (!openSlots.has(instant.getTime())) {
    return { ok: false, error: 'time_not_open', instruction: 'That exact time is not open. Offer one of the open times from the availability result.' };
  }

  const reason = reasonText.slice(0, 100);
  // provider is added here by code (the caller is never asked); the workflow
  // resolves the saved calendar connection from it. phone is sent only if known.
  const payload = {
    userId: session.userId,
    provider: 'google',
    name,
    email,
    startTime: `${date}T${time}:00${offset}`,
    endTime: new Date(instant.getTime() + duration * 60000).toISOString(),
    notes: reason,
    timeZone: tz,
  };
  if (phone) payload.phone = phone;
  const res = await triggerAutomation(session.env, 'book_appointment', payload);

  if (isInsufficientCredits(res)) {
    return { ok: false, error: 'service_unavailable', instruction: 'Booking is not available right now. Take their details and say the team will follow up.' };
  }
  if (res?.available === false) {
    return { ok: false, error: 'slot_taken', instruction: 'That time was just taken. Apologise briefly and offer another time (you may check availability again).' };
  }
  if (res?.status === true) {
    session.bookingsMade += 1;
    session.bookingConfirmed = { name, date, time };
    return { ok: true, booked: true, name, date, time, duration_minutes: duration };
  }
  return { ok: false, error: 'booking_failed', instruction: 'The booking did not go through. Do not claim it did. Take their details and say the team will follow up.' };
}

// Up to `max` evenly spread local clock labels ("10:00 AM") from slot starts.
function spreadLabels(starts, timeZone, max) {
  if (!starts.length) return [];
  const sorted = [...new Set(starts)].sort((a, b) => a - b);
  const pick = [];
  if (sorted.length <= max) pick.push(...sorted);
  else for (let i = 0; i < max; i++) pick.push(sorted[Math.round((i * (sorted.length - 1)) / (max - 1))]);
  return pick.map((ms) =>
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
  );
}
