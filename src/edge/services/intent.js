// Pure logic, no dependencies -- copied over unchanged except CommonJS -> ESM.

const INTENT_PATTERNS = {
  book_appointment: [
    /\b(book|schedule|appointment|reserve|set up a meeting|make an appointment)\b/i
  ],
  check_availability: [
    /\b(available|availability|free slot|open slot|when can|do you have time)\b/i
  ],
  cancel_appointment: [
    /\b(cancel|cancellation|cancel my|remove my booking)\b/i
  ],
  get_info: [
    /\b(hours|location|address|price|cost|how much|services|what do you offer)\b/i
  ]
};

function detectIntent(transcript) {
  if (!transcript) return null;

  for (const [intentType, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(transcript)) {
        return { type: intentType };
      }
    }
  }

  return null;
}

function buildN8nPayload(intent, session, transcript) {
  if (intent.type === 'check_availability') {
    return {
      userId: session.userId,
      // NOTE: this is the OAuth provider (Google Calendar), unrelated to
      // session.provider (which means the telephony channel: web/twilio/
      // telnyx). Hardcoded because Google is the only real, configured
      // OAuth provider right now -- see knoxified-auth's providers.js.
      provider: 'google',
      tool: 'checkAvailableSlot',
      date: extractDate(transcript),
      duration: extractDuration(transcript),
    };
  }

  if (intent.type === 'book_appointment') {
    const duration = extractDuration(transcript);
    const startTime = extractDateTime(transcript);
    return {
      userId: session.userId,
      provider: 'google',
      name: extractName(session.messages) || 'Phone caller',
      email: extractEmail(transcript),
      phone: session.callerNumber,
      startTime,
      endTime: startTime ? addMinutesIso(startTime, duration) : null,
      notes: extractNotes(transcript),
    };
  }

  // cancel_appointment / get_info: no n8n webhook wired up for these yet
  // (see webhookMap in n8n.js) -- returning null here rather than a
  // payload shaped for a webhook that doesn't exist.
  return null;
}

function extractDate(transcript) {
  const now = new Date();
  const d = /tomorrow/i.test(transcript) ? new Date(now.getTime() + 86400000) : now;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function extractDuration(transcript) {
  const hourMatch = transcript.match(/\b(an?|1)\s*hour\b/i);
  if (hourMatch) return 60;
  const halfMatch = transcript.match(/\bhalf\s*(an?\s*)?hour\b/i);
  if (halfMatch) return 30;
  const minMatch = transcript.match(/\b(\d{1,3})\s*min(ute)?s?\b/i);
  if (minMatch) return parseInt(minMatch[1], 10);
  return 30; // default slot length, matches AppointMate's own default
}

function addMinutesIso(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

function extractEmail(transcript) {
  const match = transcript.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function extractNotes(transcript) {
  // Becomes the Google Calendar event title (AppointMate's `summary`
  // field) -- keep it short. Falls back to a generic label rather than
  // dumping the raw transcript in as the event title.
  return transcript && transcript.length <= 120 ? transcript : 'Booked via AI voice agent call';
}

function extractDateTime(transcript) {
  const now = new Date();

  if (/tomorrow/i.test(transcript)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const timeMatch = transcript.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2] || '0');
      const ampm = timeMatch[3].toLowerCase();

      if (ampm === 'pm' && hours !== 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      tomorrow.setHours(hours, minutes, 0, 0);
    } else {
      tomorrow.setHours(10, 0, 0, 0);
    }

    return tomorrow.toISOString();
  }

  return null;
}

function extractName(messages) {
  for (const msg of messages) {
    if (msg.role === 'user') {
      const nameMatch = msg.content.match(
        /(?:my name is|i'm|i am|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
      );
      if (nameMatch) return nameMatch[1];
    }
  }
  return null;
}

export { detectIntent, buildN8nPayload };
