const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

function createLiveTranscription(onTranscript, onError) {
  const connection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en',
    encoding: 'mulaw',
    sample_rate: 8000,
    smart_format: true,
    punctuate: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
    vad_events: true
  });

  // Track the last confirmed interim transcript
  // so utterance_end can use it as fallback
  let lastInterimTranscript = '';

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log('[STT] Deepgram live connection opened');
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    const isFinal = data.is_final;
    const speechFinal = data.speech_final;

    if (!transcript || transcript.trim().length === 0) return;

    if (isFinal) {
      // Always track the latest confirmed interim
      lastInterimTranscript = transcript;
    }

    if (speechFinal) {
      // Clean path — speech endpoint detected with transcript
      console.log(`[STT] Final: "${transcript}"`);
      lastInterimTranscript = ''; // reset after use
      onTranscript(transcript, true);
    } else if (isFinal) {
      console.log(`[STT] Interim: "${transcript}"`);
    }
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    // Fires when Deepgram detects end of utterance
    // If speech_final already fired, lastInterimTranscript is empty — skip
    // If speech_final didn't fire but we have an interim — use it as fallback
    if (lastInterimTranscript.trim().length > 0) {
      console.log(`[STT] UtteranceEnd fallback: "${lastInterimTranscript}"`);
      const toSend = lastInterimTranscript;
      lastInterimTranscript = ''; // reset before async call
      onTranscript(toSend, true);
    } else {
      console.log('[STT] Utterance end event (no fallback needed)');
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('[STT] Deepgram error:', err.message || err);
    if (onError) onError(err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log('[STT] Deepgram connection closed');
  });

  return connection;
}

// Keep-alive: prevents Deepgram from closing idle connections
function keepAlive(connection) {
  return setInterval(() => {
    if (connection?.getReadyState() === 1) {
      connection.keepAlive();
    }
  }, 8000);
}

module.exports = { createLiveTranscription, keepAlive };