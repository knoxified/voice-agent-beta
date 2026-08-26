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

const DEEPGRAM_LIVE_URL =
  'https://api.deepgram.com/v1/listen' +
  '?model=nova-3&language=en&encoding=mulaw&sample_rate=8000' +
  '&smart_format=true&punctuate=true&interim_results=true' +
  '&endpointing=300&utterance_end_ms=1000&vad_events=true';

/**
 * Opens a live transcription connection to Deepgram.
 *
 * @param {object} env - needs DEEPGRAM_API_KEY
 * @param {(transcript: string, isFinal: boolean) => void} onTranscript
 * @param {(err: Error) => void} onError
 * @returns {Promise<WebSocket>} the open Deepgram WebSocket
 */
async function createLiveTranscription(env, onTranscript, onError) {
  const res = await fetch(DEEPGRAM_LIVE_URL, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
    },
  });

  const ws = res.webSocket;
  if (!ws) {
    throw new Error('Deepgram did not return a WebSocket upgrade');
  }
  ws.accept();

  let lastInterimTranscript = '';

  ws.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return; // Deepgram can send non-JSON keepalive frames; ignore
    }

    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;

      if (!transcript || transcript.trim().length === 0) return;

      if (isFinal) {
        lastInterimTranscript = transcript;
      }

      if (speechFinal) {
        console.log(`[STT] Final: "${transcript}"`);
        lastInterimTranscript = '';
        onTranscript(transcript, true);
      } else if (isFinal) {
        console.log(`[STT] Interim: "${transcript}"`);
      }
    } else if (data.type === 'UtteranceEnd') {
      if (lastInterimTranscript.trim().length > 0) {
        console.log(`[STT] UtteranceEnd fallback: "${lastInterimTranscript}"`);
        const toSend = lastInterimTranscript;
        lastInterimTranscript = '';
        onTranscript(toSend, true);
      } else {
        console.log('[STT] Utterance end event (no fallback needed)');
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

  console.log('[STT] Deepgram live connection opened');
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