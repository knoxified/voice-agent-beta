// Ported from axios + Node's Buffer to native fetch + Uint8Array -- neither
// axios nor Buffer are reliable in the Workers runtime; fetch and
// ArrayBuffer/Uint8Array are native Web APIs Workers is built around.

async function synthesizeSpeech(env, text) {
  if (!text || text.trim().length === 0) return null;
  const provider = env.TTS_PROVIDER || 'cartesia';
  if (provider === 'cartesia') return synthesizeCartesia(env, text);
  return synthesizeTelnyx(env, text);
}

async function synthesizeCartesia(env, text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8s max

  try {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': env.CARTESIA_API_KEY,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-2',
        transcript: text,
        voice: {
          mode: 'id',
          id: env.CARTESIA_VOICE_ID_DEFAULT || env.CARTESIA_VOICE_ID || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
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
