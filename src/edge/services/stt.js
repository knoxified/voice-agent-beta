// Bypasses @deepgram/sdk entirely and speaks Deepgram's live-transcription
// WebSocket protocol directly. Two reasons:
//   1. Avoids any uncertainty about whether the SDK itself runs cleanly in
//      the Workers runtime (unconfirmed either way -- this sidesteps the
//      question rather than guessing).
//   2. Workers' fetch()-based WebSocket upgrade supports setting a custom
//      Authorization header on the outbound connection, which the plain
//      `new WebSocket()` constructor cannot do (a real browser/Workers
//      limitation) -- so this uses the exact same
//      `Authorization: Token <key>` scheme the SDK/REST API already use,
//      rather than a different, less-certain query-param auth variant.
//
// NOTE: this is the one piece of the whole rewrite I could not verify
// against Deepgram's real servers from this environment (no network path
// to deepgram.com from the sandbox this was built in). It's written
// correctly against Deepgram's documented protocol and event shapes
// (matching the existing SDK-based version's behavior message-for-message),
// but it has not been confirmed against a real live connection the way
// everything else in this rewrite was.

function buildDeepgramUrl(opts = {}) {
  const encoding = opts.encoding || 'mulaw';
  const sampleRate = opts.sampleRate || 8000;
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    encoding,
    sample_rate: String(sampleRate),
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: String(opts.endpointingMs || 300),
    // Deepgram rejects (HTTP 400) anything below 1000 ms for utterance_end_ms.
    utterance_end_ms: String(Math.max(1000, Number(opts.utteranceEndMs) || 1000)),
    vad_events: 'true',
  });
  if (encoding === 'linear16') params.set('channels', '1');
  // Nova-3 keyterm prompting: boosts recognition of business-specific words.
  for (const term of opts.keyterms || []) params.append('keyterm', term);
  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
}

/**
 * Opens a live transcription connection to Deepgram.
 *
 * Turn handling: Deepgram emits several is_final segments per utterance and
 * marks the last with speech_final. We join all segments and only deliver
 * the turn after a short debounce with no further speech, so a natural pause
 * mid-sentence no longer splits the caller's turn into fragments.
 *
 * @param {object} env - needs DEEPGRAM_API_KEY (optional STT_DEBOUNCE_MS)
 * @param {(transcript: string, isFinal: boolean) => void} onTranscript
 * @param {(err: Error) => void} onError
 * @param {() => void} [onActivity] fired whenever the caller is audibly speaking
 * @param {{encoding?: string, sampleRate?: number, keyterms?: string[], endpointingMs?: number}} [opts]
 * @returns {Promise<WebSocket>} the open Deepgram WebSocket
 */
async function createLiveTranscription(env, onTranscript, onError, onActivity, opts = {}) {
  if (!env.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is not set on this worker');
  }
  const connect = (o) =>
    fetch(buildDeepgramUrl(o), {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      },
    });

  let res = await connect(opts);
  // A 400 is usually a rejected parameter (e.g. a keyterm). Retry once without
  // keyterms so the caller is still heard.
  if (!res.webSocket && res.status === 400 && opts.keyterms?.length) {
    console.error('[STT] Deepgram rejected request (400), retrying without keyterms:', (await res.text()).slice(0, 300));
    res = await connect({ ...opts, keyterms: [] });
  }

  const ws = res.webSocket;
  if (!ws) {
    // Surface Deepgram's actual reason (401 bad key, 402 no credit, 400 bad param...)
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`Deepgram did not return a WebSocket upgrade (HTTP ${res.status}) ${detail}`);
  }
  ws.accept();

  const debounceMs = Number(env.STT_DEBOUNCE_MS ?? 400);
  // A sentence that trails off ("I noticed a little", "it will") is almost
  // never the end of the caller's turn, so wait much longer before replying.
  const incompleteMs = Number(env.STT_INCOMPLETE_MS ?? 1600);
  const DANGLING = /\b(a|an|the|and|but|or|so|to|of|in|on|at|for|with|my|i|i'm|i've|it|it's|that|is|was|will|would|if|because|like|um|uh|about|from|by|then|also|just|really|kind of|sort of)[\s.,…-]*$/i;
  const isComplete = (t) => {
    const x = t.trim();
    return /[.!?]["')\]]*$/.test(x) && !DANGLING.test(x.replace(/[.!?]+$/, ''));
  };
  let pending = '';
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = pending.trim();
    pending = '';
    if (text) {
      console.log(`[STT] Final: "${text}"`);
      onTranscript(text, true);
    }
  };

  ws.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return; // Deepgram can send non-JSON keepalive frames; ignore
    }

    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || transcript.trim().length === 0) return;

      if (onActivity) onActivity(transcript); // caller is audibly speaking (interim or final)

      // More speech arrived: the caller is still talking, cancel any pending delivery.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (data.is_final) {
        pending += (pending ? ' ' : '') + transcript;
        console.log(`[STT] Segment: "${transcript}"`);
      }
      if (data.speech_final && pending) {
        timer = setTimeout(flush, isComplete(pending) ? debounceMs : incompleteMs);
      }
    } else if (data.type === 'UtteranceEnd') {
      // ~1s of silence: deliver whatever has been finalized.
      if (pending.trim().length > 0) {
        if (isComplete(pending)) {
          console.log('[STT] UtteranceEnd flush');
          flush();
        } else if (!timer) {
          // Unfinished sentence: give the caller a little longer to continue.
          console.log('[STT] UtteranceEnd on unfinished sentence, waiting');
          timer = setTimeout(flush, Math.max(300, incompleteMs - 1000));
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    console.log('[STT] Deepgram connection closed');
  });

  ws.addEventListener('error', (event) => {
    console.error('[STT] Deepgram error:', event.message || event);
    if (onError) onError(event);
  });

  console.log(`[STT] Deepgram live connection opened (${opts.encoding || 'mulaw'} ${opts.sampleRate || 8000}Hz, ${(opts.keyterms || []).length} keyterms)`);
  return ws;
}

/** Sends a raw mulaw audio chunk to Deepgram. */
function sendAudio(ws, audioBytes) {
  if (ws.readyState === 1) {
    ws.send(audioBytes);
  }
}

/** Keep-alive: prevents Deepgram from closing an idle connection. */
function keepAlive(ws) {
  return setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }
  }, 8000);
}

export { createLiveTranscription, sendAudio, keepAlive };