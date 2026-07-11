const axios = require('axios');

const TTS_PROVIDER = process.env.TTS_PROVIDER || 'cartesia';

// ─── Main entry point ─────────────────────────────────────
async function synthesizeSpeech(text) {
  if (!text || text.trim().length === 0) return null;
  if (TTS_PROVIDER === 'cartesia') return synthesizeCartesia(text);
  return synthesizeTelnyx(text);
}

// ─── Cartesia Sonic — streaming endpoint ──────────────────
// Using streaming bytes API so audio starts flowing immediately
// instead of waiting for the entire file to generate
async function synthesizeCartesia(text) {
  try {
    const response = await axios.post(
      'https://api.cartesia.ai/tts/bytes',
      {
        model_id: 'sonic-2',
        transcript: text,
        voice: {
          mode: 'id',
          id: process.env.CARTESIA_VOICE_ID_DEFAULT ||
              process.env.CARTESIA_VOICE_ID ||
              'e07c00bc-4134-4eae-9ea4-1a55fb45746b'
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',   // Twilio expects mulaw 8kHz
          sample_rate: 8000
        },
        // Keep language explicit for speed
        language: 'en'
      },
      {
        headers: {
          'X-API-Key': process.env.CARTESIA_API_KEY,
          'Cartesia-Version': '2024-06-10',
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 8000          // 8s max — if it takes longer something is wrong
      }
    );

    const audio = Buffer.from(response.data);
    console.log(`[TTS] Cartesia generated ${audio.length} bytes`);
    return audio;

  } catch (err) {
    // Log the actual Cartesia error body if available
    if (err.response?.data) {
      const errText = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString()
        : JSON.stringify(err.response.data);
      console.error('[TTS] Cartesia error body:', errText);
    } else {
      console.error('[TTS] Cartesia error:', err.message);
    }
    throw err;
  }
}

// ─── Telnyx native TTS marker ─────────────────────────────
async function synthesizeTelnyx(text) {
  return {
    __telnyxNativeTTS: true,
    text,
    voice: process.env.TELNYX_TTS_VOICE || 'Polly.Amy',
    language: 'en-US'
  };
}

module.exports = { synthesizeSpeech };