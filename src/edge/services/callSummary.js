// End-of-call analysis for the dashboard: Calls page, Home line and the Leads
// table. Outcome is decided from plain facts about the call (never by the
// model). The model only reads the transcript and fills in a few labelled
// fields, each checked against a fixed list, so a bad answer can never put
// junk in the dashboard. Never throws.

import { generateResponse } from './llm.js';

export function decideOutcome({ callerSpoke, bookingConfirmed, questionsLogged, followUp }) {
  if (!callerSpoke) return 'abandoned';
  if (bookingConfirmed) return 'booked';
  if (questionsLogged > 0 || followUp) return 'escalated';
  return 'answered';
}

const FALLBACK = {
  abandoned: 'Hung up before saying anything',
  booked: 'Booked an appointment',
  escalated: 'Asked something the team needs to answer',
  answered: 'Asked a question and got an answer',
};

const URGENCY = new Set(['low', 'normal', 'high', 'emergency']);
const TONES = new Set(['calm', 'friendly', 'chatty', 'rushed', 'anxious', 'upset', 'frustrated', 'neutral']);

function clean(text, max) {
  const t = String(text || '').replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, max);
  return t || null;
}

export async function buildCallSummary(env, { messages, outcome }) {
  const base = { summary: FALLBACK[outcome], reason: null, urgency: null, tone: null, name: null };
  if (outcome === 'abandoned') return base;

  const transcript = (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content.trim()}`)
    .join('\n')
    .slice(-3500);
  if (!transcript) return base;

  try {
    const raw = await generateResponse(
      env,
      [
        {
          role: 'system',
          content:
            'You analyse a phone call for a business owner. Reply with ONLY a JSON object, no other text, with these keys:\n' +
            '"summary": one short sentence (under 12 words) of what the caller wanted, e.g. "Asked about teeth whitening prices".\n' +
            '"reason": the reason for the call in 2 to 6 words, e.g. "tooth pain".\n' +
            '"urgency": one of low, normal, high, emergency (emergency only for danger to health or property right now).\n' +
            '"tone": the caller\'s tone, one of calm, friendly, chatty, rushed, anxious, upset, frustrated, neutral.\n' +
            '"name": the caller\'s own name if THEY said it, otherwise null.\n' +
            'Never guess. Use null for anything not clearly in the call.',
        },
        { role: 'user', content: transcript },
      ],
      0.1
    );

    const json = JSON.parse(String(raw || '').replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/)?.[0] || '{}');
    const urgency = String(json.urgency || '').toLowerCase();
    const tone = String(json.tone || '').toLowerCase();
    const name = clean(json.name, 60);
    return {
      summary: clean(json.summary, 120) && clean(json.summary, 120).length >= 5 ? clean(json.summary, 120) : FALLBACK[outcome],
      reason: clean(json.reason, 60),
      urgency: URGENCY.has(urgency) ? urgency : null,
      tone: TONES.has(tone) ? tone : null,
      // A single capitalised word or two, not a sentence the model made up.
      name: name && /^[\p{L}][\p{L}'-]*(\s[\p{L}][\p{L}'-]*)?$/u.test(name) ? name : null,
    };
  } catch {
    return base;
  }
}
