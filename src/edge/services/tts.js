// Ported from axios + Node's Buffer to native fetch + Uint8Array -- neither
// axios nor Buffer are reliable in the Workers runtime; fetch and
// ArrayBuffer/Uint8Array are native Web APIs Workers is built around.

async function synthesizeSpeech(env, text, voiceId) {
  if (!text || text.trim().length === 0) return null;
  const provider = env.TTS_PROVIDER || 'cartesia';
  if (provider === 'cartesia') return synthesizeCartesia(env, text, voiceId);
  return synthesizeTelnyx(env, text, voiceId);
}

async function synthesizeCartesia(env, text, voiceId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8s max

  try {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': env.CARTESIA_API_KEY,
        // sonic-2 was fully discontinued by Cartesia on 2026-06-01 (see
        // docs.cartesia.ai/changelog/2026) -- calls made against it since
        // then have been failing. sonic-3 is the current stable model and
        // needs a newer API version header.
        'Cartesia-Version': '2026-03-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: env.CARTESIA_MODEL_ID || 'sonic-3',
        transcript: text,
        voice: {
          mode: 'id',
          // Per-client voice choice (user_voice_settings.preferred_voice_id)
          // wins when present; falls back to env default, then the
          // hardcoded default voice.
          id: voiceId || env.CARTESIA_VOICE_ID_DEFAULT || env.CARTESIA_VOICE_ID || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw', // Twilio/Telnyx expect mulaw 8kHz
          sample_rate: 8000,
        },
        language: 'en',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[TTS] Cartesia error body:', errText);
      throw new Error(`Cartesia TTS failed: ${res.status}`);
    }

    const audio = new Uint8Array(await res.arrayBuffer());
    console.log(`[TTS] Cartesia generated ${audio.length} bytes`);
    return audio;
  } catch (err) {
    console.error('[TTS] Cartesia error:', err.message);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeTelnyx(env, text) {
  return {
    __telnyxNativeTTS: true,
    text,
    voice: env.TELNYX_TTS_VOICE || 'Polly.Amy',
    language: 'en-US',
  };
}

export { synthesizeSpeech };
