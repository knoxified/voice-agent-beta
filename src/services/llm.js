const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

async function generateResponse(messages) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: 80,
      temperature: 0.7,
      stream: false
    });

    const response = completion.choices[0]?.message?.content?.trim();
    console.log(`[LLM] Tokens used: ${completion.usage?.total_tokens}`);
    return response || null;

  } catch (err) {
    console.error('[LLM] Groq error:', err.message);
    throw err;
  }
}

module.exports = { generateResponse };