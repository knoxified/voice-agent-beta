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
          date: { type: 'string', description: 'The day to check, YYYY-MM-DD, in the business local calendar.' },
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
        'Book the appointment. ONLY call this when ALL are true: the caller is a genuine fit, they have agreed to the next step, they chose a specific day and time, and you have collected their full name, a valid email address and (if you do not already have their number) a phone number. If anything is missing, ask for it naturally instead of calling this.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Caller's full name." },
          email: { type: 'string', description: "Caller's email address, spelled out exactly as confirmed." },
          phone: { type: 'string', description: "Caller's phone number. Omit if you already have the number they are calling from." },
          date: { type: 'string', description: 'Appointment day, YYYY-MM-DD, business local calendar.' },
          time: { type: 'string', description: 'Appointment start time, 24-hour HH:MM, business local time.' },
          duration_minutes: { type: 'integer', description: 'Length in minutes. Default 30.' },
          reason: { type: 'string', description: 'Short reason for the visit, under 80 characters.' },
        },
        required: ['name', 'email', 'date', 'time'],
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
  });

  if (isInsufficientCredits(res)) {
    return { ok: false, error: 'service_unavailable', instruction: 'Scheduling is not available right now. Offer to take a message so the team can follow up.' };
  }
  if (!res || res.available !== true) {
    return { ok: false, error: 'lookup_failed', instruction: 'You could not reach the calendar. Offer to take a message so the team can follow up.' };
  }

  const summary = String(res.summary || '');
  session.availabilityNotes.push({ date, summary });
  return { ok: true, date, summary, hasOpenings: Array.isArray(res.freeSlots) && res.freeSlots.length > 0 };
}

async function runBooking(session, args) {
  const tz = businessTimeZone(session);
  const name = String(args.name || '').trim();
  const email = String(args.email || '').trim().toLowerCase();
  const date = String(args.date || '').trim();
  const time = String(args.time || '').trim();
  const phone = String(args.phone || '').trim() || session.callerNumber || '';

  const missing = [];
  if (name.length < 2) missing.push('full name');
  if (!EMAIL_RE.test(email)) missing.push('a valid email address');
  if (!phone) missing.push('a phone number');
  if (!isRealDate(date) || !TIME_RE.test(time)) missing.push('a specific day and time');
  if (missing.length) {
    return { ok: false, error: 'missing_details', missing, instruction: `Do not book yet. Naturally ask the caller for: ${missing.join(', ')}.` };
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

  const reason = String(args.reason || 'Appointment').trim().slice(0, 80);
  const res = await triggerAutomation(session.env, 'book_appointment', {
    userId: session.userId,
    provider: 'google',
    name,
    email,
    phone,
    startTime: `${date}T${time}:00${offset}`,
    endTime: new Date(instant.getTime() + duration * 60000).toISOString(),
    notes: `${reason} - ${name}`.slice(0, 120),
  });

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
