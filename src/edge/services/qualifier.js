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

Be strict. Small talk or one vague mention is "discover". Choose "agreed" only if the agent proposed the step first and the caller said yes.
Be slow to choose "not_fit": use it only for a wrong number, spam, abuse, or something clearly unrelated AFTER the caller has had a chance to explain. A symptom, problem or request that could plausibly relate to the business (for example jaw, face or chewing pain for a dental practice) is "discover" or "qualified", never "not_fit".`;

export async function classifyStage(env, messages, { businessName, criteria } = {}) {
  const convo = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
    .join('\n');
  if (!convo) return null;

  const groq = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 0, timeout: 3000 });
  // Same brain as the conversation by default: it is the one model we know is
  // live on this account. Override with GROQ_CLASSIFIER_MODEL if you add a faster one.
  const model = env.GROQ_CLASSIFIER_MODEL || env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const reasoning = /gpt-oss|qwen3|deepseek-r1/i.test(model);

  const params = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Business: ${businessName || 'a local business'}${criteria ? `\nWhat "qualified" means for this industry (follow this over the generic definition): ${String(criteria).slice(0, 1200)}` : ''}\n\nConversation:\n${convo}\n\nJSON:` },
    ],
    temperature: 0,
    // Reasoning models spend tokens thinking before the answer; leave room.
    max_tokens: reasoning ? 400 : 60,
  };
  if (reasoning) params.reasoning_effort = 'low';
  else params.response_format = { type: 'json_object' };

  const call = groq.chat.completions.create(params);
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('classifier timeout')), 3000));

  try {
    const res = await Promise.race([call, timeout]);
    const text = res.choices[0]?.message?.content || '';
    const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (!STAGES.has(parsed.stage)) return null;
    return { stage: parsed.stage, reason: String(parsed.reason || '').slice(0, 80) };
  } catch (err) {
    console.warn('[Stage] classifier failed:', err.message);
    return null;
  }
}
