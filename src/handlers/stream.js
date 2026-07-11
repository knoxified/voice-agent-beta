const { getSession, updateSession } = require('../services/session');
const { createLiveTranscription, keepAlive } = require('../services/stt');
const { generateResponse } = require('../services/llm');
const { synthesizeSpeech } = require('../services/tts');
const { detectIntent, buildN8nPayload } = require('../services/intent');
const { triggerAutomation } = require('../services/n8n');

async function mediaStreamHandler(ws, req) {
  let callId        = null;
  let session       = null;
  let streamSid     = null;
  let provider      = null;
  let dgConnection  = null;    // Deepgram live connection
  let keepAliveTimer = null;
  let isProcessing  = false;   // prevent overlapping LLM calls

  console.log('[Stream] New WebSocket connection');

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { event } = msg;

    // ── CONNECTED ─────────────────────────────────────────
    if (event === 'connected') {
      console.log('[Stream] Twilio WebSocket connected');
      return;
    }

    // ── START ─────────────────────────────────────────────
    if (event === 'start') {
      streamSid = msg.streamSid;
      callId = msg.start?.customParameters?.CallSid
            || msg.start?.callSid
            || msg.start?.call_control_id;

      // Telnyx fallback
      if (!callId && msg.start?.stream_sid) {
        streamSid = msg.start.stream_sid;
        callId    = msg.start.call_control_id;
      }

      session = await getSession(callId);
      if (!session) {
        console.error(`[Stream] No session for ${callId}`);
        ws.close();
        return;
      }

      provider = session.provider || 'twilio';
      console.log(`[Stream] Started | user: ${session.userId || session.tenantId} | provider: ${provider}`);

      session.messages = [{
        role: 'system',
        content: buildSystemPrompt(session)
      }];
      await updateSession(callId, { messages: session.messages, streamSid });

      // ── Open Deepgram live connection ──────────────────
      // onTranscript fires when Deepgram detects end of utterance
      dgConnection = createLiveTranscription(
        async (transcript, isSpeechFinal) => {
          // Only act on complete utterances
          if (!isSpeechFinal) return;
          if (isProcessing) {
            console.log('[Stream] Still processing previous turn, skipping');
            return;
          }
          isProcessing = true;
          await processTurn(ws, streamSid, callId, session, transcript, provider);
          isProcessing = false;
        },
        (err) => console.error('[STT] Connection error:', err.message)
      );

      keepAliveTimer = keepAlive(dgConnection);

      // ── Send greeting ──────────────────────────────────
      try {
        const greetingText = session.agentGreeting ||
          'Hello, thank you for calling. How can I help you?';
        const t0 = Date.now();
        const greetingAudio = await synthesizeSpeech(greetingText);
        console.log(`[Timing] Greeting TTS: ${Date.now() - t0}ms`);
        sendAudio(ws, streamSid, greetingAudio, provider);
      } catch (err) {
        console.error('[Stream] Greeting error:', err.message);
      }
      return;
    }

    // ── MEDIA ─────────────────────────────────────────────
    if (event === 'media') {
      // Skip our own TTS being echoed back
      if (msg.media?.track === 'outbound') return;

      // Stream audio chunk directly to Deepgram — no buffering
      // Deepgram handles endpointing and fires onTranscript when ready
      if (dgConnection?.getReadyState() === 1) {
        const chunk = Buffer.from(msg.media.payload, 'base64');
        dgConnection.send(chunk);
      }
      return;
    }

    // ── STOP ──────────────────────────────────────────────
    if (event === 'stop') {
      console.log(`[Stream] Stopped | callId: ${callId}`);
      cleanup();
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log(`[Stream] WebSocket closed | callId: ${callId}`);
    cleanup();
  });

  ws.on('error', (err) => {
    console.error(`[Stream] WS error:`, err.message);
    cleanup();
  });

  function cleanup() {
    clearInterval(keepAliveTimer);
    try { dgConnection?.finish(); } catch { /* ignore */ }
  }
}

// ─── Core pipeline with full timing ───────────────────────
async function processTurn(ws, streamSid, callId, session, transcript, provider) {
  const turnStart = Date.now();
  console.log(`\n[Timing] ── Turn started ──────────────────`);
  console.log(`[STT] "${transcript}"`);

  try {
    session.messages.push({ role: 'user', content: transcript });

    // Intent detection
    const intent = detectIntent(transcript);
    let automationResult = null;
    if (intent) {
      console.log(`[Intent] ${intent.type}`);
      const ta = Date.now();
      const payload = buildN8nPayload(intent, session, transcript);
      automationResult = await triggerAutomation(intent.type, payload);
      console.log(`[Timing] Automation: ${Date.now() - ta}ms`);
    }

    // LLM
    const llmMessages = automationResult
      ? [...session.messages, {
          role: 'system',
          content: `Automation result: ${JSON.stringify(automationResult)}. Use naturally.`
        }]
      : session.messages;

    const t2 = Date.now();
    const aiText = await generateResponse(llmMessages);
    console.log(`[Timing] LLM: ${Date.now() - t2}ms`);
    console.log(`[LLM] "${aiText}"`);

    if (!aiText) return;

    session.messages.push({ role: 'assistant', content: aiText });
    if (session.messages.length > 22) {
      const sys = session.messages[0];
      session.messages = [sys, ...session.messages.slice(-20)];
    }
    await updateSession(callId, { messages: session.messages });

    // TTS
    const t3 = Date.now();
    const audioResponse = await synthesizeSpeech(aiText);
    console.log(`[Timing] TTS: ${Date.now() - t3}ms`);

    // Send audio
    sendAudio(ws, streamSid, audioResponse, provider);
    console.log(`[Timing] ── Total turn: ${Date.now() - turnStart}ms ──\n`);

  } catch (err) {
    console.error(`[Turn] Error after ${Date.now() - turnStart}ms:`, err.message);
    try {
      const fallback = await synthesizeSpeech("Sorry, could you repeat that?");
      sendAudio(ws, streamSid, fallback, provider);
    } catch { /* silent */ }
  }
}

// ─── Send audio to Twilio/Telnyx ──────────────────────────
function sendAudio(ws, streamSid, audioBuffer, provider) {
  if (!audioBuffer || ws.readyState !== 1) return;
  if (audioBuffer.__telnyxNativeTTS) return;

  const sidKey = provider === 'twilio' ? 'streamSid' : 'stream_sid';
  ws.send(JSON.stringify({
    event: 'media',
    [sidKey]: streamSid,
    media: { payload: audioBuffer.toString('base64') }
  }));
}

// ─── System prompt ────────────────────────────────────────
function buildSystemPrompt(session) {
  return `You are an AI ${session.agentPersona || 'receptionist'} for ${session.tenantName || 'this business'}.

Rules — this is a phone call:
- Maximum 2 sentences per response, no exceptions
- No bullet points, lists, or markdown ever
- Speak naturally and conversationally
- For appointments: collect name, date, time, reason
- If unsure, offer to take a message

Today: ${new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })}.`;
}

module.exports = { mediaStreamHandler };