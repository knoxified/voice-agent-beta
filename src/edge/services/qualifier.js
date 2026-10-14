// Fast, cheap "where is this conversation?" judge. It runs in PARALLEL with the
// main reply on every caller turn, so it adds no latency, and its verdict
// decides (a) what the agent is nudged to do next and (b) whether the booking
// tools are available at all. Keeping the tools out of sight until the caller
// has actually agreed to a next step is what stops the agent from fixating on
// the calendar, and it scales: more automations later never clutter the
// conversation because they only appear once the stage unlocks them.

import Groq from 'groq-sdk';

const STAGES = new Set(['discover', 'qualified', 'agreed', 'declined', 'not_fit']);

const SYSTEM = `You judge phone conversations for a business. Decide the caller's CURRENT stage.
Reply with JSON only: {"stage":"discover|qualified|agreed|declined|not_fit","reason":"max 8 words"}

Stages:
- discover: still learning what the caller needs, small talk, or the need is vague.
- qualified: the caller described a specific, real need the business could help with AND shows they want to act on it (asks what to do, wants it looked at, asks about cost, timing or process). The agent has NOT yet proposed a concrete next step (visit, appointment, consultation, viewing, call-back).
- agreed: the agent proposed a concrete next step AND the caller clearly accepted it.
- declined: the caller turned the next step down, or only wants information.
- not_fit: wrong number, spam, unrelated to the business, or abusive.

Be strict. Small talk or one vague mention is "discover". Choose "agreed" only if the agent proposed the step first and the caller said yes.`;

export async function classifyStage(env, messages, { businessName } = {}) {
  const convo = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
    .join('\n');
  if (!convo) return null;

  const groq = new Groq({ apiKey: env.GROQ_API_KEY });
  const model = env.GROQ_CLASSIFIER_MODEL || 'llama-3.1-8b-instant';

  const call = groq.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Business: ${businessName || 'a local business'}\n\nConversation:\n${convo}\n\nJSON:` },
    ],
    temperature: 0,
    max_tokens: 60,
    response_format: { type: 'json_object' },
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('classifier timeout')), 5000));

  try {
    const res = await Promise.race([call, timeout]);
    const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
    if (!STAGES.has(parsed.stage)) return null;
    return { stage: parsed.stage, reason: String(parsed.reason || '').slice(0, 80) };
  } catch (err) {
    console.warn('[Stage] classifier failed:', err.message);
    return null;
  }
}
