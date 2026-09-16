const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
// openai/gpt-oss-* are reasoning models: they spend part of the token budget
// on an internal reasoning step before writing the final answer into
// `content`. With a small budget (e.g. 80 tokens) that reasoning step alone
// can consume the whole thing, leaving `content` empty even though real
// tokens were used. Reasoning models need more headroom, and since this is a
// low-latency voice agent, we want fast/short replies, not deep
// chain-of-thought — so reasoning_effort is kept low.
const IS_REASONING_MODEL = MODEL.startsWith('openai/gpt-oss');

async function generateResponse(messages, temperature = 0.7) {
  try {
    const params = {
      model: MODEL,
      messages,
      max_tokens: IS_REASONING_MODEL ? 300 : 80,
      temperature,
      stream: false
    };
    if (IS_REASONING_MODEL) {
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

module.exports = { generateResponse };