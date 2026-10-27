import Groq from 'groq-sdk';

// ── Rate-limit helpers ────────────────────────────────────────────────────────

// Groq 429 messages say "Please try again in 5.3s." — pull that number out.
function parseRetryAfterMs(err) {
  const msg = String(err?.message || err?.error?.message || '');
  const m = msg.match(/try again in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cloudflare Workers AI fallback (same model, separate quota) ───────────────
// Used when Groq returns 429 and the wait is too long (or a second 429 fires).
// env.AI binding is wired in wrangler.jsonc under "ai": { "binding": "AI" }.

/**
 * Cloudflare Workers AI binding requires message content to be a plain string.
 * The Groq conversation history can have:
 *   - content as an array (multi-part messages)
 *   - content as null (assistant messages that only made tool calls)
 *   - role 'tool' (tool results — CF binding doesn't support this role)
 * Strip or flatten all of these before sending.
 */
function sanitizeForCF(messages) {
  return messages.reduce((acc, msg) => {
    const role = msg.role;
    if (!['system', 'user', 'assistant'].includes(role)) return acc;

    let content;
    if (Array.isArray(msg.content)) {
      content = msg.content.filter(c => c?.type === 'text').map(c => c.text).join(' ').trim();
    } else if (msg.content === null || msg.content === undefined) {
      if (msg.tool_calls?.length) return acc; // tool-call-only assistant turn — skip
      content = '';
    } else {
      content = String(msg.content);
    }

    if (role === 'assistant' && !content) return acc;
    acc.push({ role, content });
    return acc;
  }, []);
}

async function callCloudflareFallback(env, messages, tools, maxTokens) {
  if (!env?.AI) throw new Error('[CF] AI binding not available');

  const payload = {
    messages: sanitizeForCF(messages),
    max_tokens: maxTokens || 300,
    stream: false,
  };
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
    payload.parallel_tool_calls = false;
  }

  const out = await env.AI.run('@cf/openai/gpt-oss-20b', payload);

  // Workers AI returns different shapes depending on the model/version:
  //   legacy:        { response, tool_calls: [{ name, arguments }] }
  //   chat format:   { choices: [{ message: { content, tool_calls } }] }
  //   responses API: { output: [{ type: 'message', content: [{ type: 'output_text', text }] },
  //                             { type: 'function_call', name, arguments }] }
  // Read all of them, otherwise a perfectly good answer shows up as "null".
  const msg = out?.choices?.[0]?.message;
  const outputItems = Array.isArray(out?.output) ? out.output : [];
  const outputText = outputItems
    .filter((o) => o?.type === 'message')
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((c) => c?.type === 'output_text' && c.text)
    .map((c) => c.text)
    .join(' ');
  const cfContent = String(
    (typeof out?.response === 'string' ? out.response : '') || msg?.content || outputText || ''
  ).trim() || null;

  const rawCalls = [
    ...(Array.isArray(out?.tool_calls) ? out.tool_calls : []),
    ...(Array.isArray(msg?.tool_calls) ? msg.tool_calls : []),
    ...outputItems.filter((o) => o?.type === 'function_call'),
  ];

  // Normalise to the OpenAI shape the rest of the code expects (arguments as a JSON string).
  let cfToolCalls = null;
  if (rawCalls.length) {
    cfToolCalls = rawCalls.map((tc, i) => {
      const fn = tc.function || tc;
      const args = fn.arguments;
      return {
        id: tc.id || tc.call_id || `cf_${i}`,
        type: 'function',
        function: {
          name: fn.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    });
  }

  if (!cfContent && !cfToolCalls) {
    console.error('[CF] Empty fallback reply, response keys:', Object.keys(out || {}).join(','));
  }

  return {
    content: cfContent,
    toolCalls: cfToolCalls,
    assistantMessage: cfToolCalls
      ? { role: 'assistant', content: cfContent, tool_calls: cfToolCalls }
      : null,
  };
}

// openai/gpt-oss-* are reasoning models: they spend part of the token budget
// on an internal reasoning step before writing the final answer into
// `content`. With a small budget that reasoning step alone can consume the
// whole thing, leaving `content` empty. Reasoning models need more headroom,
// and since this is a low-latency voice agent, reasoning_effort is kept low.
function isReasoningModel(model) {
  return model.startsWith('openai/gpt-oss');
}

async function generateResponse(env, messages, temperature = 0.7) {
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });
  const MODEL = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const reasoningModel = isReasoningModel(MODEL);

  try {
    const params = {
      model: MODEL,
      messages,
      max_tokens: reasoningModel ? 300 : 80,
      temperature,
      stream: false,
    };
    if (reasoningModel) {
      params.reasoning_effort = 'low';
    }

    const completion = await groq.chat.completions.create(params);

    const response = completion.choices[0]?.message?.content?.trim();
    console.log(`[LLM] Tokens used: ${completion.usage?.total_tokens}`);

    if (!response) {
      console.error(`[LLM] Empty content from ${MODEL} — finish_reason: ${completion.choices[0]?.finish_reason}`);
    }

    return response || null;
  } catch (err) {
    console.error('[LLM] Groq error:', err.message);
    throw err;
  }
}


// Same as generateResponse, but can return tool calls. Returns
// { content, toolCalls, assistantMessage }. If the model emits a malformed
// tool call (Groq rejects it with tool_use_failed), retry once without tools
// so the caller still gets a spoken answer instead of silence.
async function generateWithTools(env, messages, temperature = 0.7, tools = null) {
  const groq = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 1, timeout: 8000 });
  const MODEL = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const reasoningModel = isReasoningModel(MODEL);

  const build = (withTools) => {
    const params = {
      model: MODEL,
      messages,
      max_tokens: reasoningModel ? (withTools ? 500 : 300) : (withTools ? 200 : 80),
      temperature,
      stream: false,
    };
    if (reasoningModel) params.reasoning_effort = 'low';
    if (withTools && tools && tools.length) {
      params.tools = tools;
      params.tool_choice = 'auto';
      params.parallel_tool_calls = false;
    }
    return params;
  };

  let completion;
  try {
    completion = await groq.chat.completions.create(build(true));
  } catch (err) {
    const msg = String(err.message || '');
    if (tools && (msg.includes('tool_use_failed') || msg.includes('Failed to call a function'))) {
      console.warn('[LLM] tool_use_failed, retrying without tools');
      completion = await groq.chat.completions.create(build(false));
    } else if (err?.status === 429) {
      // Rate-limit: wait the exact retry-after window if short, then try once
      // more on Groq; otherwise go straight to the Cloudflare fallback.
      const waitMs = parseRetryAfterMs(err);
      if (waitMs && waitMs <= 2000) {
        console.warn(`[LLM] 429 — waiting ${waitMs}ms then retrying Groq`);
        await sleep(waitMs);
        try {
          completion = await groq.chat.completions.create(build(true));
        } catch (err2) {
          if (err2?.status === 429) {
            console.warn('[LLM] 429 again — falling back to Cloudflare');
            return callCloudflareFallback(env, messages, tools, build(true).max_tokens);
          }
          throw err2;
        }
      } else {
        console.warn('[LLM] 429 long wait — falling back to Cloudflare');
        return callCloudflareFallback(env, messages, tools, build(true).max_tokens);
      }
    } else {
      console.error('[LLM] Groq error:', msg);
      throw err;
    }
  }

  const message = completion.choices[0]?.message || {};
  console.log(`[LLM] Tokens used: ${completion.usage?.total_tokens}`);
  const toolCalls = message.tool_calls && message.tool_calls.length ? message.tool_calls : null;
  const content = message.content?.trim() || null;
  if (!content && !toolCalls) {
    console.error(`[LLM] Empty content from ${MODEL} — finish_reason: ${completion.choices[0]?.finish_reason}`);
  }
  return {
    content,
    toolCalls,
    assistantMessage: toolCalls ? { role: 'assistant', content: message.content ?? null, tool_calls: toolCalls } : null,
  };
}


// ---- Streaming reply -------------------------------------------------------
// Same contract as generateWithTools, but the spoken answer is handed to
// onSentence() one complete sentence at a time AS the model writes it, so the
// caller hears the first sentence while the rest is still being generated.
// Tool-call turns are unchanged: if the model asks for a tool, nothing is
// spoken from the stream (except any short lead-in text it wrote first).

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

async function streamWithTools(env, messages, temperature = 0.7, tools = null, onSentence = () => {}) {
  // A live call can't wait: give up after 7s (no hidden retry backoff) and let the caller's turn fall back.
  const groq = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 0, timeout: 7000 });
  const MODEL = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const reasoningModel = isReasoningModel(MODEL);

  const params = {
    model: MODEL,
    messages,
    max_tokens: reasoningModel ? (tools?.length ? 500 : 300) : (tools?.length ? 200 : 80),
    temperature,
    stream: true,
  };
  if (reasoningModel) params.reasoning_effort = 'low';
  if (tools && tools.length) {
    params.tools = tools;
    params.tool_choice = 'auto';
    params.parallel_tool_calls = false;
  }

  let stream;
  try {
    stream = await groq.chat.completions.create(params);
  } catch (err) {
    if (err?.status === 429) {
      console.warn('[LLM] stream 429 — falling back to Cloudflare (non-streaming)');
      return callCloudflareFallback(env, messages, tools, params.max_tokens);
    }
    throw err;
  }

  let full = '';
  let pending = '';
  let sawToolCall = false;
  let streamedAny = false;
  const calls = [];

  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta;
    if (!d) continue;

    if (d.tool_calls?.length) {
      sawToolCall = true;
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
      if (!sawToolCall) {
        pending += d.content;
        const { sentences, rest } = takeSentences(pending);
        pending = rest;
        for (const sentence of sentences) {
          streamedAny = true;
          await onSentence(sentence, false);
        }
      }
    }
  }

  const toolCalls = calls.filter(Boolean).length ? calls.filter(Boolean) : null;

  // Whatever is left after the last sentence boundary: speak it now (final piece).
  if (!toolCalls && pending.trim()) {
    streamedAny = true;
    await onSentence(pending.trim(), true);
  }

  const content = full.trim() || null;
  if (!content && !toolCalls) console.error(`[LLM] Empty streamed content from ${MODEL}`);
  return {
    content,
    toolCalls,
    assistantMessage: toolCalls ? { role: 'assistant', content: content, tool_calls: toolCalls } : null,
    streamed: streamedAny && !toolCalls,
    streamedLeadIn: streamedAny && !!toolCalls,
  };
}

export { generateResponse, generateWithTools, streamWithTools };
