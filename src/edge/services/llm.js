import Groq from 'groq-sdk';

// openai/gpt-oss-* are reasoning models: they spend part of the token budget
// on an internal reasoning step before writing the final answer into
// `content`. With a small budget that reasoning step alone can consume the
// whole thing, leaving `content` empty. Reasoning models need more headroom,
// and since this is a low-latency voice agent, reasoning_effort is kept low.
function isReasoningModel(model) {
  return model.startsWith('openai/gpt-oss');
}

async function generateResponse(env, messages) {
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });
  const MODEL = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const reasoningModel = isReasoningModel(MODEL);

  try {
    const params = {
      model: MODEL,
      messages,
      max_tokens: reasoningModel ? 300 : 80,
      temperature: 0.7,
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

export { generateResponse };
