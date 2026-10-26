// LLM tools the voice agent can call mid-conversation. These replace the old
// keyword-regex intent trigger: the model decides WHEN (guided by the prompt),
// but this module decides whether a call is actually allowed to reach the
// AppointMate webhook. Every webhook call costs the account credits, so the
// guard here is deliberately strict and independent of the model.

import { triggerAutomation } from './n8n.js';
import { rangesLabels } from './scheduling.js';
import { logPendingQuestion } from './supabase.js';

const MAX_AVAILABILITY_CHECKS = 4; // per call (1 credit each)
const MAX_BOOKINGS = 2; // per call (2 credits each)
const MAX_DAYS_AHEAD = 120;

// check_availability is run by the code (scheduling.js) when the caller names a
// day, NOT by the model, so the calendar is checked once per day, never invented.
export const AVAILABILITY_TOOL = {
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
};


const MAX_QUESTIONS = 3; // per call

// Offered on every turn: when the caller asks something the agent genuinely
// cannot answer from its notes, it hands the question to the owner instead of
// guessing. Costs nothing (no webhook).
// Whenever the agent promises "the team will follow up / call you back", this
// records it on the caller's lead, with a confirmed way to reach them.
export const MESSAGE_TOOL = {
  type: 'function',
  function: {
    name: 'take_message',
    description:
      'Use whenever you tell the caller the team will follow up, call them back, or send them something, or when they ask to leave a message. Call it BEFORE you say that. If you are not on a call with a phone number (a web call), you need their best phone number or email first: ask, read it back, get a yes. On a phone call the number they are calling from is already known, so do not ask for it.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What the team should follow up about, in one short sentence (for example "Jaw pain for 4 days, wants advice and a visit").' },
        callback_phone: { type: 'string', description: 'Best number to reach them, ONLY if they gave one and you read it back.' },
        callback_email: { type: 'string', description: 'Email to reach them, ONLY if they gave one and you read it back.' },
        name: { type: 'string', description: "Caller's name, only if they said it." },
      },
      required: ['message'],
    },
  },
};

export const QUESTION_TOOL = {
  type: 'function',
  function: {
    name: 'take_question',
    description:
      'Use ONLY when the caller asks a factual question about the business (price, policy, service, availability of something) that is NOT answered in your notes. Never guess. This passes the question to the owner, who will follow up. Do not use it for small talk, booking, or things you can answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "The caller's question, restated clearly in one short sentence." },
      },
      required: ['question'],
    },
  },
};

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Book the appointment. Call this ONLY after ALL of these are true: the caller is a genuine fit and agreed to come in, they chose a time from the calendar results in your notes, you collected their full name and email, read both back, and the caller said yes. If anything is missing, keep collecting it instead of calling this. A phone number is optional and must never be requested.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Caller's full name, exactly as confirmed." },
          email: { type: 'string', description: "Caller's email address, exactly as confirmed." },
          date: { type: 'string', description: 'Appointment day, YYYY-MM-DD, from the Upcoming days list.' },
          time: { type: 'string', description: 'Appointment start time, 24-hour HH:MM, one of the times check_availability returned.' },
          reason: { type: 'string', description: 'One short sentence on the main reason for the call and visit, from what the caller told you (for example "Itchy fluid-filled bumps on hand for about 5 days"). Under 100 characters.' },
          details_confirmed: { type: 'boolean', description: 'true ONLY if you read the name and email back and the caller confirmed they are correct.' },
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
  if (name === 'take_question') return runTakeQuestion(session, args);
  if (name === 'take_message') return runTakeMessage(session, args);
  return { ok: false, error: 'unknown_tool' };
}


async function runTakeMessage(session, args) {
  const message = String(args.message || '').trim().slice(0, 300);
  if (message.length < 4) {
    return { ok: false, error: 'empty_message', instruction: 'Ask what they would like the team to follow up about.' };
  }
  const digits = String(args.callback_phone || '').replace(/\D/g, '');
  const phone = digits.length >= 7 && digits.length <= 15 ? (String(args.callback_phone).trim().startsWith('+') ? '+' : '') + digits : '';
  const email = String(args.callback_email || '').trim().toLowerCase();
  const emailOk = EMAIL_RE.test(email) ? email : '';
  const hasCallerId = !!(session.callerNumber && String(session.callerNumber).replace(/\D/g, '').length >= 6);

  if (!phone && !emailOk && !hasCallerId) {
    return {
      ok: false,
      error: 'need_contact',
      instruction: 'You have no way to reach them yet. Ask for the best phone number or email, read it back digit by digit or letter by letter, and call this again once they say yes.',
    };
  }
  session.followUp = {
    message,
    phone: phone || null,
    email: emailOk || null,
    name: String(args.name || '').trim().slice(0, 80) || null,
  };
  return {
    ok: true,
    noted: true,
    instruction: hasCallerId && !phone && !emailOk
      ? 'Tell them, naturally, that you have noted it and the team will call them back on the number they are calling from. Then continue.'
      : 'Tell them, naturally, that you have noted it and the team will reach out on the contact they gave. Then continue.',
  };
}

async function runTakeQuestion(session, args) {
  const question = String(args.question || '').trim();
  if (question.length < 4) {
    return { ok: false, error: 'empty_question', instruction: 'Ask the caller to repeat what they want to know.' };
  }
  if ((session.questionsLogged || 0) >= MAX_QUESTIONS) {
    return { ok: true, noted: true, instruction: 'Already noted several questions. Say the team will follow up on those, and move on.' };
  }
  session.questionsLogged = (session.questionsLogged || 0) + 1;
  await logPendingQuestion(session.env, session.userId, question, session.callId, session.callerNumber);
  return {
    ok: true,
    noted: true,
    instruction: 'Tell the caller, briefly and naturally, that you have noted their question and the team will get back to them. Do not guess an answer. Then continue the conversation.',
  };
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
    openRanges: rangesLabels(starts, tz),
    hasOpenings: starts.length > 0,
    instruction: starts.length
      ? 'Offer two or three of these times naturally (for example "I have 10 or 2:30"). Never read the whole list.'
      : 'Nothing is open that day. Offer another day.',
  };
  session.availabilityCache.set(date, result);
  return result;
}


// Spoken emails are the most error-prone thing on a call. Catch the common
// domain typos (and speech-to-text slips like ".con") before they become a
// booking that never reaches the caller.
const DOMAIN_FIXES = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gamil.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'outlook.con': 'outlook.com',
  'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com',
};

function emailDomainSuggestion(email) {
  const domain = String(email || '').split('@')[1] || '';
  return DOMAIN_FIXES[domain] || (domain.endsWith('.con') ? domain.slice(0, -1) + 'm' : null);
}

async function runBooking(session, args) {
  const tz = businessTimeZone(session);
  // The time the caller chose is locked in by the code; the model cannot drift from it.
  if (session.selectedSlot) args = { ...args, date: session.selectedSlot.date, time: session.selectedSlot.time };
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

  // A likely typo in the domain: have the agent double-check once. If the
  // caller confirms the same address, the second attempt goes through.
  const suggestion = emailDomainSuggestion(email);
  if (suggestion) {
    session.emailDoubleChecked = session.emailDoubleChecked || new Set();
    if (!session.emailDoubleChecked.has(email)) {
      session.emailDoubleChecked.add(email);
      return {
        ok: false,
        error: 'email_domain_check',
        instruction: `Do not book yet. The email domain may have been misheard. Ask naturally: "Just to be sure, is that ${suggestion.replace('.', ' dot ')}?" If they say yes, use the corrected address. If they insist the original is right, call this again with the original.`,
        suggestedEmail: email.split('@')[0] + '@' + suggestion,
      };
    }
  }

  if (args.details_confirmed !== true) {
    return {
      ok: false,
      error: 'details_not_confirmed',
      instruction: 'Do not book yet. Repeat the name back, then read the email back in short pieces (the part before the at sign, then at, then the domain as one word), ask if both are correct, fix only what is wrong, and call this again once they say yes.',
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
    session.capturedContact = { name, email }; // saved to the caller's lead when the call ends

    // Demo mode: send the booking confirmation + invite email via Brevo.
    if (session.isDemo && email) {
      import('./brevo.js').then(({ sendDemoBookingEmail }) =>
        sendDemoBookingEmail(session.env, {
          toEmail: email,
          toName: name,
          industry: session.effectiveSystemType || session.systemTypeOverride,
          startTime: payload.startTime,
        })
      ).catch((e) => console.error('[Demo] booking email failed:', e.message));
    }

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
