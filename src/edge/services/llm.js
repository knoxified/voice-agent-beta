import Groq from 'groq-sdk';

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

  const stream = await groq.chat.completions.create(params);

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
