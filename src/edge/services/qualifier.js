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

// Models that said "not found / retired / no access" are skipped for the life
// of the isolate, so one dead id can never stall the agent again.
const deadModels = new Set();
const DEAD_RE = /model_not_found|no such model|not found|does not exist|do not have access|deprecated|decommission|retired|\b5007\b/i;

// Order matters: Cloudflare small models first (separate provider, tiny Neuron
// cost, never touches the Groq quota the conversation uses), then a Groq model
// that is NOT the conversation model (Groq limits are per model).
// Override with CF_CLASSIFIER_MODELS="id1,id2" and GROQ_CLASSIFIER_MODEL.
const DEFAULT_CF_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const DEFAULT_GROQ_BACKUP = 'openai/gpt-oss-120b';

function modelChain(env) {
  const cf = String(env.CF_CLASSIFIER_MODELS || '')
    .split(',').map((m) => m.trim()).filter(Boolean);
  const chain = [];
  if (env.AI) for (const id of (cf.length ? cf : DEFAULT_CF_MODELS)) chain.push({ provider: 'cf', id });
  if (env.GROQ_API_KEY) chain.push({ provider: 'groq', id: env.GROQ_CLASSIFIER_MODEL || DEFAULT_GROQ_BACKUP });
  return chain.filter((m) => !deadModels.has(`${m.provider}:${m.id}`));
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('classifier timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function parseVerdict(text) {
  const parsed = JSON.parse((String(text || '').match(/\{[\s\S]*\}/) || ['{}'])[0]);
  if (!STAGES.has(parsed.stage)) throw new Error('unusable verdict');
  return { stage: parsed.stage, reason: String(parsed.reason || '').slice(0, 80) };
}

async function runOne(env, m, messages) {
  if (m.provider === 'cf') {
    const out = await withTimeout(env.AI.run(m.id, { messages, max_tokens: 80, temperature: 0 }), 2500);
    const text = (typeof out?.response === 'string' && out.response) || out?.choices?.[0]?.message?.content || '';
    return parseVerdict(text);
  }
  const reasoning = /gpt-oss|qwen3|deepseek-r1/i.test(m.id);
  const groq = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 0, timeout: 3000 });
  const params = { model: m.id, messages, temperature: 0, max_tokens: reasoning ? 400 : 60 };
  if (reasoning) params.reasoning_effort = 'low';
  else params.response_format = { type: 'json_object' };
  const res = await withTimeout(groq.chat.completions.create(params), 3000);
  return parseVerdict(res.choices[0]?.message?.content);
}

// Returns { stage, reason } or null when every model failed. The caller keeps
// the last known stage on null (see CallSession.updateStage).
export async function classifyStage(env, messages, { businessName, criteria } = {}) {
  const convo = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
    .join('\n');
  if (!convo) return null;

  const prompt = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Business: ${businessName || 'a local business'}${criteria ? `\nWhat "qualified" means for this industry (follow this over the generic definition): ${String(criteria).slice(0, 1200)}` : ''}\n\nConversation:\n${convo}\n\nJSON:` },
  ];

  const failures = [];
  for (const m of modelChain(env)) {
    try {
      const verdict = await runOne(env, m, prompt);
      return { ...verdict, model: m.id };
    } catch (err) {
      const msg = String(err?.message || err);
      failures.push(`${m.id}: ${msg.slice(0, 80)}`);
      if (DEAD_RE.test(msg)) {
        deadModels.add(`${m.provider}:${m.id}`);
        console.warn(`[Stage] ${m.id} is unavailable and will be skipped from now on`);
      }
    }
  }
  console.warn(`[Stage] ALL classifier models failed (${failures.length ? failures.join(' | ') : 'none configured'})`);
  return null;
}
