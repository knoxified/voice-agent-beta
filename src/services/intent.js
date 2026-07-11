// ─── Keyword patterns that trigger automations ────────────
// Keep this simple — LLM confirmed the intent, we just route it
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

// ─── Detect intent from transcript ────────────────────────
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

// ─── Build payload to send to n8n webhook ─────────────────
function buildN8nPayload(intent, session, transcript) {
  const base = {
    tenantId: session.tenantId,
    callerNumber: session.callerNumber,
    transcript,
    intentType: intent.type,
    timestamp: new Date().toISOString()
  };

  // Extract any data the LLM has already collected from the conversation
  // This is a simple extraction — for production you'd use structured outputs
  if (intent.type === 'book_appointment' || intent.type === 'check_availability') {
    return {
      ...base,
      tool: intent.type === 'check_availability' ? 'checkAvailableSlot' : 'bookAppointment',
      // These will be populated by LLM extraction in a future enhancement
      // For now, n8n will ask for missing fields via the AI response
      startTime: extractDateTime(transcript),
      name: extractName(session.messages),
      email: null,
      phone: session.callerNumber
    };
  }

  return base;
}

// ─── Simple date/time extraction ──────────────────────────
// Basic — catches common patterns like "tomorrow at 3pm"
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
      tomorrow.setHours(10, 0, 0, 0); // Default 10am
    }

    return tomorrow.toISOString();
  }

  return null;
}

// ─── Try to find caller's name from conversation history ──
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

module.exports = { detectIntent, buildN8nPayload };
