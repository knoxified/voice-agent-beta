// Ported from axios + Node's Buffer to native fetch + Uint8Array -- neither
// axios nor Buffer are reliable in the Workers runtime; fetch and
// ArrayBuffer/Uint8Array are native Web APIs Workers is built around.

async function synthesizeSpeech(env, text, voiceId, outputFormat = 'call') {
  if (!text || text.trim().length === 0) return null;
  const provider = env.TTS_PROVIDER || 'cartesia';
  if (provider === 'cartesia') return synthesizeCartesia(env, text, voiceId, outputFormat);
  return synthesizeTelnyx(env, text, voiceId);
}

async function synthesizeCartesia(env, text, voiceId, outputFormat = 'call') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8s max

  // 'call' = raw mu-law 8kHz for the live Twilio/Telnyx audio path (unchanged
  // from before). 'mp3' = a normal, browser-playable file -- used by the
  // /voice/preview endpoint, never by an in-progress call.
  const format =
    outputFormat === 'mp3'
      ? { container: 'mp3', bit_rate: 64000, sample_rate: 44100 }
      : { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 };

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
        output_format: format,
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


// Streams Cartesia audio to `onChunk` as it is generated instead of waiting
// for the whole clip, so the caller hears the first words ~0.5s sooner.
// Raw mu-law is 1 byte per sample, so any chunk boundary is safe. Returns
// total bytes sent. Falls back to the buffered path for non-Cartesia TTS.
const EMOTIONS = new Set(['neutral', 'content', 'calm', 'sympathetic', 'enthusiastic', 'curious', 'confident', 'apologetic']);

// Cartesia sonic-3 accepts speed 0.6-1.5 and (beta) an emotion as guidance.
function buildGenerationConfig(opts = {}) {
  const cfg = {};
  const speed = Number(opts.speed);
  if (Number.isFinite(speed) && speed > 0) cfg.speed = Math.min(1.5, Math.max(0.6, speed));
  if (opts.emotion && EMOTIONS.has(String(opts.emotion))) cfg.emotion = String(opts.emotion);
  return Object.keys(cfg).length ? cfg : null;
}

async function streamSpeech(env, text, voiceId, onChunk, shouldStop, opts = {}) {
  if (!text || text.trim().length === 0) return 0;
  const provider = env.TTS_PROVIDER || 'cartesia';
  if (provider !== 'cartesia') {
    const audio = await synthesizeSpeech(env, text, voiceId);
    if (audio) onChunk(audio);
    return audio?.length || 0;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const baseBody = {
      model_id: env.CARTESIA_MODEL_ID || 'sonic-3',
      transcript: text,
      voice: {
        mode: 'id',
        id: voiceId || env.CARTESIA_VOICE_ID_DEFAULT || env.CARTESIA_VOICE_ID || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
      },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      language: 'en',
    };
    const request = (generationConfig) =>
      fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'X-API-Key': env.CARTESIA_API_KEY,
          'Cartesia-Version': '2026-03-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(generationConfig ? { ...baseBody, generation_config: generationConfig } : baseBody),
        signal: controller.signal,
      });

    // Delivery (speed/emotion) is guidance and the emotion list is a beta: if
    // Cartesia rejects it, drop emotion, then drop the config, so the caller
    // always hears the reply rather than silence.
    const genCfg = buildGenerationConfig(opts);
    let res = await request(genCfg);
    if (!res.ok && genCfg?.emotion && (res.status === 400 || res.status === 422)) {
      console.warn('[TTS] emotion rejected, retrying without it');
      const { emotion, ...rest } = genCfg;
      res = await request(Object.keys(rest).length ? rest : null);
    }
    if (!res.ok && genCfg && (res.status === 400 || res.status === 422)) {
      console.warn('[TTS] generation_config rejected, retrying plain');
      res = await request(null);
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      console.error('[TTS] Cartesia stream error body:', errText);
      throw new Error(`Cartesia TTS failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    let total = 0;
    const t0 = Date.now();
    for (;;) {
      if (shouldStop && shouldStop()) {
        await reader.cancel().catch(() => {});
        console.log('[TTS] stopped early (caller barged in)');
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        total += value.length;
        onChunk(value);
      }
    }
    console.log(`[TTS] Cartesia streamed ${total} bytes in ${Date.now() - t0}ms`);
    return total;
  } catch (err) {
    console.error('[TTS] Cartesia stream error:', err.message);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export { synthesizeSpeech, streamSpeech, EMOTIONS };
