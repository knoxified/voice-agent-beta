// ── LLM router ────────────────────────────────────────────────────────────────
// One conversation, several free quotas. Every turn walks a chain of providers
// and uses the first one that answers. A provider that rate-limits (or errors)
// is put on a cool-down so later turns skip it instantly instead of paying a
// failed request first.
//
// Two chains, so the providers share the work instead of fighting over one quota:
//
//   Conversation (the agent speaking; LLM_CHAIN, default "groq,cf,openrouter,gemini")
//     groq        fastest, so it speaks first        (GROQ_API_KEY, GROQ_MODEL)
//     cf          Cloudflare Workers AI binding      (AI binding, CF_MAIN_MODEL)
//     openrouter  ":free" models only, 3rd fallback  (OPENROUTER_API_KEY, OPENROUTER_MODELS)
//     gemini      Google free tier, 4th fallback     (GEMINI_API_KEY, GEMINI_MODELS)
//
//   Background work (stage classifier, call summary...; LLM_BG_CHAIN, default
//   "gemini,openrouter,cf"): runs beside the conversation on the quotas the
//   conversation is NOT using, so it never competes with Groq's per-minute budget.
//
// All but `cf` speak the OpenAI chat-completions format, so one client covers them.

const PROVIDER_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

const FIRST_TOKEN_MS = 5000;   // give up on a provider that has not started answering
const OVERALL_MS = 20000;


// ── Cool-downs (per isolate) ──────────────────────────────────────────────────
const coolUntil = new Map(); // "provider:model" -> epoch ms

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5);
}

function isCooling(key) {
  const t = coolUntil.get(key);
  if (!t) return false;
  if (Date.now() >= t) { coolUntil.delete(key); return false; }
  return true;
}

class LlmError extends Error {
  constructor(message, { status = 0, retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(text, headers) {
  const h = headers?.get?.('retry-after');
  if (h && !Number.isNaN(Number(h))) return Math.ceil(Number(h) * 1000);
  const m = String(text || '').match(/try again in ([\d.]+)\s*(ms|s|m)?|retryDelay"?\s*:\s*"?([\d.]+)s/i);
  if (!m) return null;
  if (m[3]) return Math.ceil(parseFloat(m[3]) * 1000);
  const n = parseFloat(m[1]);
  return Math.ceil(m[2] === 'ms' ? n : m[2] === 'm' ? n * 60000 : n * 1000);
}

// Decide how long to skip a provider after a failure.
function coolDown(key, err) {
  const msg = String(err?.message || '');
  let until;
  if (err?.status === 429) {
    const daily = /per[ -]?day|daily|\bTPD\b|\bRPD\b|PerDay/i.test(msg);
    until = daily ? nextUtcMidnight() : Date.now() + Math.min(Math.max(err.retryAfterMs || 20000, 5000), 90000);
  } else if (err?.status === 401 || err?.status === 403) {
    until = Date.now() + 10 * 60000; // bad / blocked key: do not hammer it
    console.error(`[LLM] ${key} rejected our key (HTTP ${err.status}). Check the secret.`);
  } else if (err?.status === 404 || /model_not_found|no such model|does not exist|decommission|deprecated/i.test(msg)) {
    until = Date.now() + 6 * 3600000; // model gone: stop asking
  } else {
    until = Date.now() + 15000; // 5xx, timeout, network
  }
  coolUntil.set(key, until);
  console.warn(`[LLM] ${key} unavailable for ${Math.round((until - Date.now()) / 1000)}s (${err?.status || 'err'}: ${msg.slice(0, 140)})`);
}

// ── Chain construction ────────────────────────────────────────────────────────
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function buildChain(env, background = false) {
  const order = list(background ? (env.LLM_BG_CHAIN || 'gemini,openrouter,cf') : (env.LLM_CHAIN || 'groq,cf,openrouter,gemini'));
  const chain = [];
  for (const p of order) {
    if (p === 'gemini' && env.GEMINI_API_KEY) {
      for (const model of list((background && env.GEMINI_BG_MODELS) || env.GEMINI_MODELS || 'gemini-2.5-flash-lite')) chain.push({ provider: 'gemini', model });
    } else if (p === 'groq' && env.GROQ_API_KEY) {
      chain.push({ provider: 'groq', model: env.GROQ_MODEL || 'openai/gpt-oss-20b' });
    } else if (p === 'openrouter' && env.OPENROUTER_API_KEY) {
      for (const model of list(env.OPENROUTER_MODELS || 'openai/gpt-oss-20b:free,google/gemma-4-26b-a4b-it:free,openai/gpt-oss-120b:free')) {
        // Hard guard: only ":free" ids may ever be sent, so a typo cannot spend credits.
        if (!model.endsWith(':free')) { console.error(`[LLM] Refusing non-free OpenRouter model "${model}"`); continue; }
        chain.push({ provider: 'openrouter', model });
      }
    } else if (p === 'cf' && env.AI) {
      // Background jobs are small, so they use a small (cheap in Neurons) model.
      chain.push({ provider: 'cf', model: background ? (env.CF_BG_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8-fast') : (env.CF_MAIN_MODEL || '@cf/openai/gpt-oss-20b') });
    }
  }
  return chain;
}

const isReasoning = (model) => /gpt-oss|qwen3|deepseek-r1|gemma-4/i.test(model) && !/gemini/i.test(model);

function maxTokensFor(entry, hasTools, override) {
  if (override) return override;
  if (isReasoning(entry.model)) return hasTools ? 700 : 450; // reasoning eats the budget before any answer
  return hasTools ? 350 : 250;
}

function buildBody(env, entry, messages, temperature, tools, stream, override) {
  const body = {
    model: entry.model,
    messages,
    temperature,
    max_tokens: maxTokensFor(entry, !!tools?.length, override),
    stream,
  };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (entry.provider === 'groq') {
    if (tools?.length) body.parallel_tool_calls = false;
    if (isReasoning(entry.model)) body.reasoning_effort = 'low';
    if (stream) body.stream_options = { include_usage: true };
  } else if (entry.provider === 'openrouter') {
    if (isReasoning(entry.model)) body.reasoning = { effort: 'low' };
    if (stream) body.stream_options = { include_usage: true };
    body.provider = {
      require_parameters: !!tools?.length,              // only endpoints that really support tools
      data_collection: env.OPENROUTER_ALLOW_DATA_COLLECTION === '1' ? 'allow' : 'deny', // callers' details must not be retained/trained on
    };
  }
  return body;
}

function headersFor(env, entry) {
  const key = entry.provider === 'gemini' ? env.GEMINI_API_KEY : entry.provider === 'groq' ? env.GROQ_API_KEY : env.OPENROUTER_API_KEY;
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (entry.provider === 'openrouter') { h['HTTP-Referer'] = 'https://knoxified.org'; h['X-Title'] = 'Knoxified Voice Agent'; }
  return h;
}

async function post(env, entry, body, signal) {
  const res = await fetch(PROVIDER_URLS[entry.provider], {
    method: 'POST', headers: headersFor(env, entry), body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmError(`${entry.provider} ${res.status}: ${text.slice(0, 300)}`, { status: res.status, retryAfterMs: parseRetryAfterMs(text, res.headers) });
  }
  return res;
}

function normaliseCalls(calls) {
  const out = (calls || []).filter(Boolean).filter((c) => c.function?.name).map((c, i) => ({
    id: c.id || `call_${Date.now()}_${i}`,
    type: 'function',
    function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? (c.function.arguments || '{}') : JSON.stringify(c.function.arguments ?? {}) },
  }));
  return out.length ? out : null;
}

// ── One-shot call to an OpenAI-compatible provider ───────────────────────────
async function callCompat(env, entry, messages, temperature, tools, override) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OVERALL_MS);
  try {
    const res = await post(env, entry, buildBody(env, entry, messages, temperature, tools, false, override), ctl.signal);
    const data = await res.json();
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    if (data.usage) console.log(`[LLM] ${entry.provider}/${entry.model} tokens: prompt ${data.usage.prompt_tokens} + out ${data.usage.completion_tokens}`);
    return { content: (msg.content || '').trim() || null, toolCalls: normaliseCalls(msg.tool_calls), finish: choice.finish_reason };
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError(`${entry.provider} timeout`, { status: 0 });
    throw err;
  } finally { clearTimeout(timer); }
}

// ── Cloudflare Workers AI (last resort) ───────────────────────────────────────
// The binding is happier with plain text, so tool traffic is flattened into
// notes the model can still read (dropping tool results made it hallucinate).
function flattenForCF(messages) {
  const names = {};
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) names[tc.id] = tc.function?.name;
      if (m.content) out.push({ role: 'assistant', content: String(m.content) });
      continue;
    }
    if (m.role === 'tool') {
      out.push({ role: 'system', content: `Result of ${names[m.tool_call_id] || 'tool'}: ${String(m.content).slice(0, 1500)}` });
      continue;
    }
    if (!['system', 'user', 'assistant'].includes(m.role)) continue;
    const content = Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : String(m.content ?? '');
    if (m.role === 'assistant' && !content.trim()) continue;
    out.push({ role: m.role, content });
  }
  return out;
}

async function callCloudflare(env, entry, messages, temperature, tools, override) {
  const payload = { messages: flattenForCF(messages), max_tokens: Math.max(override || 0, tools?.length ? 900 : 600), temperature, stream: false };
  if (tools?.length) payload.tools = tools;
  let out;
  try {
    out = await env.AI.run(entry.model, { ...payload, reasoning_effort: 'low' });
  } catch (err) {
    if (/reasoning|unknown|unexpected|additional/i.test(String(err?.message))) out = await env.AI.run(entry.model, payload); // param not accepted
    else throw err;
  }

  // Workers AI answers in a few shapes depending on model/version.
  const msg = out?.choices?.[0]?.message;
  const items = Array.isArray(out?.output) ? out.output : [];
  const itemText = items.filter((o) => o?.type === 'message').flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((c) => c?.type === 'output_text' && c.text).map((c) => c.text).join(' ');
  const content = String((typeof out?.response === 'string' ? out.response : '') || msg?.content || itemText || '').trim() || null;
  const raw = [...(Array.isArray(out?.tool_calls) ? out.tool_calls : []), ...(Array.isArray(msg?.tool_calls) ? msg.tool_calls : []), ...items.filter((o) => o?.type === 'function_call')];
  const toolCalls = normaliseCalls(raw.map((tc) => ({ id: tc.id || tc.call_id, function: tc.function || { name: tc.name, arguments: tc.arguments } })));
  if (!content && !toolCalls) console.error(`[LLM] cf empty reply (finish: ${out?.choices?.[0]?.finish_reason || '?'}, keys: ${Object.keys(out || {}).join(',')})`);
  return { content, toolCalls, finish: out?.choices?.[0]?.finish_reason };
}

// ── Public: non-streaming ─────────────────────────────────────────────────────
async function runChainOnce(env, messages, temperature, tools, override, background = false) {
  const chain = buildChain(env, background);
  if (!chain.length) throw new Error('No LLM provider configured');
  const failures = [];
  for (const entry of chain) {
    const key = `${entry.provider}:${entry.model}`;
    if (isCooling(key)) continue;
    try {
      const r = entry.provider === 'cf'
        ? await callCloudflare(env, entry, messages, temperature, tools, override)
        : await callCompat(env, entry, messages, temperature, tools, override);
      if (!r.content && !r.toolCalls) { failures.push(`${key}: empty`); continue; }
      console.log(`[LLM] answered by ${key}`);
      return r;
    } catch (err) {
      coolDown(key, err);
      failures.push(`${key}: ${String(err.message).slice(0, 80)}`);
    }
  }
  throw new Error(`All LLM providers failed (${failures.join(' | ') || 'all cooling down'})`);
}

// Background jobs (call summary, stage classifier): Gemini/OpenRouter first.
async function generateBackground(env, messages, { temperature = 0, maxTokens = 300 } = {}) {
  const r = await runChainOnce(env, messages, temperature, null, maxTokens, true);
  return r.content;
}

async function generateResponse(env, messages, temperature = 0.7) {
  return generateBackground(env, messages, { temperature, maxTokens: 400 });
}

async function generateWithTools(env, messages, temperature = 0.7, tools = null) {
  const r = await runChainOnce(env, messages, temperature, tools, null);
  return {
    content: r.content,
    toolCalls: r.toolCalls,
    assistantMessage: r.toolCalls ? { role: 'assistant', content: r.content ?? null, tool_calls: r.toolCalls } : null,
  };
}

// ── Public: streaming ─────────────────────────────────────────────────────────
// The spoken answer is handed to onSentence() one complete sentence at a time
// AS the model writes it. A provider is only abandoned before anything has been
// said; once audio started we stay with it.

const ABBREV_END = /\b(a\.m|p\.m|dr|mr|mrs|ms|st|vs|etc|e\.g|i\.e)\.\s*$/i;

function takeSentences(buf) {
  const sentences = [];
  const re = /[.!?]+["')\]]*\s+/g;
  let last = 0;
  let m;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    const cand = buf.slice(last, end).trim();
    if (ABBREV_END.test(cand)) continue;                       // "2 p.m. on Friday" is not a sentence end
    if (cand.replace(/\[[^\]]*\]/g, '').trim().length < 12) continue; // too short to be worth its own audio request
    sentences.push(cand);
    last = end;
  }
  return { sentences, rest: buf.slice(last) };
}


async function streamCompat(env, entry, messages, temperature, tools, onSentence) {
  const ctl = new AbortController();
  const overall = setTimeout(() => ctl.abort(), OVERALL_MS);
  let first = setTimeout(() => ctl.abort(), FIRST_TOKEN_MS);
  const started = Date.now();
  try {
    const res = await post(env, entry, buildBody(env, entry, messages, temperature, tools, true, null), ctl.signal);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let pending = '';
    let sawTool = false;
    let streamedAny = false;
    let usage = null;
    const calls = [];

    const handle = async (json) => {
      if (json.error) throw new LlmError(`${entry.provider} stream error: ${JSON.stringify(json.error).slice(0, 200)}`, { status: json.error.code || 0 });
      if (json.usage) usage = json.usage;
      const d = json.choices?.[0]?.delta;
      if (!d) return;
      if (d.tool_calls?.length) {
        sawTool = true;
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].function.name += tc.function.name;
          if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
        }
      }
      if (d.content) {
        full += d.content;
        if (!sawTool) {
          pending += d.content;
          const { sentences, rest } = takeSentences(pending);
          pending = rest;
          for (const s of sentences) { streamedAny = true; await onSentence(s, false); }
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) { clearTimeout(first); first = null; }
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        await handle(json);
      }
    }

    const toolCalls = normaliseCalls(calls);
    if (!toolCalls && pending.trim()) { streamedAny = true; await onSentence(pending.trim(), true); }
    const content = full.trim() || null;
    if (usage) console.log(`[LLM] ${entry.provider}/${entry.model} tokens: prompt ${usage.prompt_tokens} + out ${usage.completion_tokens}, first reply in ${Date.now() - started}ms total`);
    return { content, toolCalls, streamedAny };
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError(`${entry.provider} timeout`, { status: 0 });
    err.streamedAny = err.streamedAny ?? false;
    throw err;
  } finally { clearTimeout(overall); if (first) clearTimeout(first); }
}

async function streamWithTools(env, messages, temperature = 0.7, tools = null, onSentence = () => {}) {
  const chain = buildChain(env);
  if (!chain.length) throw new Error('No LLM provider configured');
  const failures = [];
  let spoke = false;
  const tracked = async (s, last) => { spoke = true; return onSentence(s, last); };

  for (const entry of chain) {
    const key = `${entry.provider}:${entry.model}`;
    if (isCooling(key)) continue;
    try {
      if (entry.provider === 'cf') {
        const r = await callCloudflare(env, entry, messages, temperature, tools, null);
        if (!r.content && !r.toolCalls) { failures.push(`${key}: empty`); continue; }
        console.log(`[LLM] answered by ${key} (not streamed)`);
        return { content: r.content, toolCalls: r.toolCalls, assistantMessage: r.toolCalls ? { role: 'assistant', content: r.content ?? null, tool_calls: r.toolCalls } : null, streamed: false, streamedLeadIn: false };
      }
      const r = await streamCompat(env, entry, messages, temperature, tools, tracked);
      if (!r.content && !r.toolCalls) { failures.push(`${key}: empty`); continue; }
      console.log(`[LLM] answered by ${key}`);
      return {
        content: r.content,
        toolCalls: r.toolCalls,
        assistantMessage: r.toolCalls ? { role: 'assistant', content: r.content, tool_calls: r.toolCalls } : null,
        streamed: r.streamedAny && !r.toolCalls,
        streamedLeadIn: r.streamedAny && !!r.toolCalls,
      };
    } catch (err) {
      if (spoke) throw err; // audio already started: do not switch voices mid-sentence
      coolDown(key, err);
      failures.push(`${key}: ${String(err.message).slice(0, 80)}`);
    }
  }
  throw new Error(`All LLM providers failed (${failures.join(' | ') || 'all cooling down'})`);
}

export { generateResponse, generateBackground, generateWithTools, streamWithTools };
