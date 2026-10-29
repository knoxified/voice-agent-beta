// LLM tools the voice agent can call mid-conversation. These replace the old
// keyword-regex intent trigger: the model decides WHEN (guided by the prompt),
// but this module decides whether a call is actually allowed to reach the
// AppointMate webhook. Every webhook call costs the account credits, so the
// guard here is deliberately strict and independent of the model.

import { triggerAutomation } from './n8n.js';
import { rangesLabels } from './scheduling.js';
import { logPendingQuestion } from './supabase.js';
import { pickRelevant } from './knowledge.js';

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

// Only offered when the owner's knowledge is too long to paste (PROMPT_RETRIEVAL=1): the agent asks for what it needs.
export const LOOKUP_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_business_info',
    description: 'Look up what you have on a business topic (prices, services, policies, hours, location, procedures) before answering a factual question. Pass a short topic in the caller\'s words.',
    parameters: { type: 'object', properties: { topic: { type: 'string', description: 'Short topic, e.g. "teeth whitening price".' } }, required: ['topic'] },
  },
};

// The caller's name, as THEY say or spell it. One source of truth: booking, follow-ups and the
// lead all use this, so a correction made mid-call is never lost.
export const NAME_TOOL = {
  type: 'function',
  function: {
    name: 'set_caller_name',
    description:
      'Call whenever the caller tells you their name, corrects it, or spells it out. Pass the full name exactly as they said or spelled it (for example if they spell F, A, V, O, R then use that spelling). Call it again after every correction. Do not use it for anyone but the caller.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The caller's name exactly as they said or spelled it." },
        spelled_out: { type: 'boolean', description: 'true if they spelled it letter by letter.' },
      },
      required: ['name'],
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

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// The business's own timezone (agent_configs.timezone, set on the dashboard voice config page).
// Used ONLY for availability, booking times and working out what "Monday"/"tomorrow" means.
export function businessTimeZone(session) {
  const tz = session.agentConfig?.timezone;
  if (validTimeZone(tz)) return tz;
  if (!session._tzWarned) {
    session._tzWarned = true;
    console.warn(tz ? `[TZ] invalid timezone "${tz}" on this tenant, using the default` : '[TZ] no timezone set for this business, using the default');
  }
  const fallback = session.env?.DEFAULT_TIMEZONE;
  return validTimeZone(fallback) ? fallback : 'Africa/Lagos';
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

  if (name === 'set_caller_name') return runSetName(session, args);
  if (name === 'lookup_business_info') return runLookup(session, args);
  if (name === 'take_question') return runTakeQuestion(session, args);
  if (name === 'take_message') return runTakeMessage(session, args);
  if (name === 'check_availability' || name === 'book_appointment') {
    const result = name === 'check_availability' ? await runAvailability(session, args) : await runBooking(session, args);
    // The system could not do it (not the caller's mistake): offer the follow-up right away, the way a person would.
    if (result && result.ok === false && SYSTEM_FAILURES.has(result.error)) {
      session.bookingFailed = true;
      session.bookingFailedTurn = session.callerTurns || 0;
      return { ...result, instruction: followUpInstruction(session, result.instruction) };
    }
    return result;
  }
  return { ok: false, error: 'unknown_tool' };
}

const SYSTEM_FAILURES = new Set(['service_unavailable', 'lookup_failed', 'booking_failed', 'limit_reached']);
const COUNTRY_CODE_RULE = 'Whenever you collect a phone number, also ask which country code it has, then read the whole number back WITH the code (plus sign, code, number) and get a yes before using it.';

function hasCallerNumber(session) {
  return !!(session.callerNumber && String(session.callerNumber).replace(/\D/g, '').length >= 6);
}

// What to say when we cannot complete something and the team has to follow up.
function followUpInstruction(session, original) {
  const failed = 'Say briefly that you could not complete that right now. Never claim it worked.';
  if (hasCallerNumber(session)) {
    return `${failed} Then offer, in your own words: "I can have the team reach out to you on this number if you are okay with that, or would you prefer email?" If they are fine with this number, use take_message (include what they wanted, and the time if there was one). If they prefer email, ask for it, read it back letter by letter, get a yes, then use take_message with callback_email.`;
  }
  return `${failed} Say this is a web call, so you do not have their number, and ask: "would you like me to get back to you by email or by number?" Email: ask for it, read it back letter by letter, get a yes, then use take_message with callback_email. Number: ${COUNTRY_CODE_RULE} Then use take_message with callback_phone including the plus and country code. (${String(original || '').slice(0, 120)})`;
}

async function runLookup(session, args) {
  const topic = String(args.topic || '').slice(0, 160);
  const found = [
    ...pickRelevant(session.kbFaqs || [], topic, 900, 3),
    ...pickRelevant(session.kbMemory || [], topic, 600, 2),
    ...pickRelevant(session.kbWebsite || [], topic, 600, 2),
  ];
  if (!found.length) {
    return { ok: true, found: false, instruction: 'You have nothing on that. Say so plainly, do not guess, and use take_question so the team can follow up.' };
  }
  return { ok: true, found: true, notes: found.join('\n---\n'), instruction: 'Answer from these notes in your own words, briefly. Do not go beyond them and do not read them out.' };
}

async function runSetName(session, args) {
  const name = String(args.name || '').replace(/[^A-Za-z\u00C0-\u024F'’ .-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  // A name is a few words. Anything that reads like an instruction is not a name (prompt-injection guard).
  if (name.length < 2 || name.split(' ').length > 5 || /\b(ignore|instruction|prompt|system|assistant|you are|act as|pretend|override|jailbreak)\b/i.test(name)) {
    return { ok: false, error: 'bad_name', instruction: 'Ask them to say or spell their name again, slowly.' };
  }
  session.confirmedName = name;
  session.callerName = name;
  const letters = name.replace(/[^A-Za-z]/g, '').split('').join(', ').toUpperCase();
  return {
    ok: true,
    instruction: `Name saved as "${name}". Read it back once, letter by letter for the part that was unclear (${letters}), and ask if that is right. If they say yes, carry on and use this name for everything. If not, ask them to spell it slowly and call set_caller_name again. Never keep using an old spelling after they corrected it.`,
  };
}


async function runTakeMessage(session, args) {
  const message = String(args.message || '').trim().slice(0, 300);
  if (message.length < 4) {
    return { ok: false, error: 'empty_message', instruction: 'Ask what they would like the team to follow up about.' };
  }
  const rawPhone = String(args.callback_phone || '').trim();
  const digits = rawPhone.replace(/\D/g, '');
  let phone = '';
  if (digits.length >= 7 && digits.length <= 15) {
    const hasPlus = rawPhone.startsWith('+');
    // No country code (local format starting 0, or a short number): ask for it, never store an ambiguous number.
    if (!hasPlus && (digits.startsWith('0') || digits.length < 11)) {
      return { ok: false, error: 'need_country_code', instruction: `Ask which country code that number has (for example plus two three four for Nigeria, plus one for the US or Canada). ${COUNTRY_CODE_RULE} Then call this again with the number written as +code then number.` };
    }
    phone = `+${digits}`;
  }
  const email = String(args.callback_email || '').trim().toLowerCase();
  const emailOk = EMAIL_RE.test(email) ? email : '';
  const hasCallerId = !!(session.callerNumber && String(session.callerNumber).replace(/\D/g, '').length >= 6);

  if (!phone && !emailOk && !hasCallerId) {
    return {
      ok: false,
      error: 'need_contact',
      instruction: hasCallerNumber(session)
        ? 'Ask whether the team may reach them on the number they are calling from, or whether they would prefer email. Read an email back letter by letter and get a yes before calling this again.'
        : `This is a web call, so you have no way to reach them yet. Ask whether they would like you to get back to them by email or by number. Read an email back letter by letter. ${COUNTRY_CODE_RULE} Call this again once they say yes.`,
    };
  }
  session.followUp = {
    message,
    phone: phone || null,
    email: emailOk || null,
    name: String(session.confirmedName || args.name || '').trim().slice(0, 80) || null,
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
  session.questionTurn = session.callerTurns || 0;
  await logPendingQuestion(session.env, session.userId, question, session.callId, session.callerNumber);

  // Can the team actually reach this caller? Phone calls have a number; web calls only if they gave one.
  const hasCallerId = !!(session.callerNumber && String(session.callerNumber).replace(/\D/g, '').length >= 6);
  const reachable = hasCallerId || !!(session.followUp?.email || session.followUp?.phone);
  if (!reachable) {
    return {
      ok: true,
      noted: true,
      instruction: 'Say plainly that you do not have that information (for example "I don\'t have the exact answer on that one"). Then, in the same reply, ask whether they would like the team to get back to them by email or by number. Read an email back letter by letter. For a number also ask the country code and read it back with the code. When they say yes, use take_message with it and what they asked. Do not guess an answer. If they do not want to give one, drop it and keep helping.',
    };
  }
  return {
    ok: true,
    noted: true,
    instruction: 'Say plainly that you do not have that information, that you have noted their question and the team will get back to them. Do not guess an answer. Then keep helping with what you do know.',
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
  const name = String(session.confirmedName || args.name || '').trim(); // a correction made mid-call always wins
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
