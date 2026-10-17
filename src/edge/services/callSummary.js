// End-of-call summary + outcome for the dashboard's Calls page and Home line.
// Outcome is decided by plain facts from the call (never by the model), so it
// is reliable; the model only writes the one-line summary, and if that fails
// a sensible fallback line is used. Never throws.

import { generateResponse } from './llm.js';

export function decideOutcome({ callerSpoke, bookingConfirmed, questionsLogged }) {
  if (!callerSpoke) return 'abandoned';
  if (bookingConfirmed) return 'booked';
  if (questionsLogged > 0) return 'escalated';
  return 'answered';
}

const FALLBACK = {
  abandoned: 'Hung up before saying anything',
  booked: 'Booked an appointment',
  escalated: 'Asked something the team needs to answer',
  answered: 'Asked a question and got an answer',
};

export async function buildCallSummary(env, { messages, outcome }) {
  if (outcome === 'abandoned') return FALLBACK.abandoned;

  const transcript = (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content.trim()}`)
    .join('\n')
    .slice(-3500);

  try {
    const text = await generateResponse(
      env,
      [
        {
          role: 'system',
          content:
            'You write one-line call summaries for a business owner. Reply with ONE short sentence (under 12 words) saying what the caller wanted, e.g. "Asked about teeth whitening prices" or "Booked a cleaning for Friday at 2pm". No quotes, no names of the agent, no trailing period.',
        },
        { role: 'user', content: transcript || '(empty)' },
      ],
      0.2
    );
    const clean = String(text || '').replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 120);
    return clean.length >= 5 ? clean : FALLBACK[outcome];
  } catch {
    return FALLBACK[outcome];
  }
}
