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
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });
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

export { generateResponse, generateWithTools };
