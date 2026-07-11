const { checkQuota, getUserByPhone, getUserVoiceSettings } = require('../services/supabase');
const { initSession, destroySession, getSession } = require('../services/session');
const { deductMinutes } = require('../services/quota');
const { makeOutboundCall } = require('../services/telnyx');  // only needed for Telnyx outbound

// ─── INBOUND: Telnyx hits this when someone calls your number ─
// Now also handles Twilio by dispatching to the right provider handler.
async function inboundCallHandler(req, res) {
  try {
    const body = req.body;

    // Detect provider from payload shape
    const isTwilio = !!(body.CallSid && body.From);           // Twilio always sends CallSid + From
    const isTelnyx = !!(body.data?.event_type);               // Telnyx wraps everything in data.payload

    if (isTwilio) return handleTwilioInbound(req, res, body);
    if (isTelnyx) return handleTelnyxInbound(req, res, body);

    // Unknown provider
    console.warn('[Inbound] Unknown webhook format:', JSON.stringify(body).slice(0, 200));
    return res.sendStatus(400);

  } catch (err) {
    console.error('[Inbound] Handler error:', err.message);
    return res.sendStatus(500);
  }
}

// ─── TELNYX inbound logic (extracted from old code) ────────
async function handleTelnyxInbound(req, res, body) {
  const event = body.data;
  const eventType = event?.event_type;

  if (eventType === 'call.initiated') {
    const callControlId = event.payload?.call_control_id;
    const toNumber = event.payload?.to;
    const fromNumber = event.payload?.from;

    console.log(`[Telnyx] Inbound call from ${fromNumber} to ${toNumber}`);

    // Step 1: Find user by phone
    const user = await getUserByPhone(toNumber);
    if (!user) {
      console.warn(`[Telnyx] No user found for number ${toNumber}`);
      return res.json({
        commands: [{
          command: 'speak',
          params: {
            payload: 'This number is not currently in service. Goodbye.',
            voice: 'en-US-Neural2-F',
            language: 'en-US'
          }
        }]
      });
    }

    // Step 2: Check quota
    const quotaOk = await checkQuota(user.id);
    if (!quotaOk) {
      console.log(`[Telnyx] User ${user.id} has no minutes remaining`);
      return res.json({
        commands: [{
          command: 'speak',
          params: {
            payload: 'Sorry, your minutes have been exhausted. Please upgrade your plan.',
            voice: 'en-US-Neural2-F',
            language: 'en-US'
          }
        }]
      });
    }

    // Step 3: Get voice settings
    const voiceSettings = await getUserVoiceSettings(user.id);

    // Step 4: Store session
    await initSession(callControlId, {
      provider: 'telnyx',         // so stream handler knows which provider
      userId: user.id,
      userEmail: user.email,
      agentPersona: voiceSettings?.agent_persona || 'professional receptionist',
      agentGreeting: voiceSettings?.agent_greeting || 'Hello, thank you for calling. How can I help you?',
      preferredVoiceId: voiceSettings?.preferred_voice_id || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
      callerNumber: fromNumber,
      callStartTime: Date.now(),
      plan: user.plan,
      callAllowed: true
    });

    // Step 5: Answer the call
    return res.json({
      commands: [{
        command: 'answer',
        params: {}
      }]
    });
  }

  if (eventType === 'call.answered') {
    const callControlId = event.payload?.call_control_id;
    return res.json({
      commands: [{
        command: 'streaming_start',
        params: {
          stream_url: `${process.env.BASE_URL.replace('https', 'wss')}/voice/stream`,
          stream_track: 'both_tracks',
          enable_dialogflow: false
        }
      }]
    });
  }

  if (eventType === 'call.hangup') {
    const callControlId = event.payload?.call_control_id;
    const callDuration = event.payload?.hangup_cause === 'normal_clearing'
      ? event.payload?.duration_secs
      : 0;

    await handleCallEnd(callControlId, callDuration);
    return res.sendStatus(200);
  }

  // All other events acknowledged
  return res.sendStatus(200);
}

// ─── TWILIO inbound logic (new) ────────────────────────────
async function handleTwilioInbound(req, res, body) {
  const { CallSid, From, To } = body;
  console.log(`[Twilio] Inbound call from ${From} to ${To} | SID: ${CallSid}`);

  // Step 1: Find user by phone (same as Telnyx)
  const user = await getUserByPhone(To);
  if (!user) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">This number is not currently in service. Goodbye.</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  // Step 2: Check quota
  const quotaOk = await checkQuota(user.id);
  if (!quotaOk) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Sorry, your minutes have been exhausted. Please upgrade your plan.</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  // Step 3: Get dynamic voice settings (same as Telnyx)
  const voiceSettings = await getUserVoiceSettings(user.id);

  // Step 4: Store session with provider:'twilio'
  await initSession(CallSid, {
    provider: 'twilio',
    userId: user.id,
    userEmail: user.email,
    agentPersona: voiceSettings?.agent_persona || 'professional receptionist',
    agentGreeting: voiceSettings?.agent_greeting || 'Hello, thank you for calling. How can I help you?',
    preferredVoiceId: voiceSettings?.preferred_voice_id || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
    callerNumber: From,
    callStartTime: Date.now(),
    plan: user.plan,
    callAllowed: true
  });

  // Step 5: Respond with TwiML that connects audio to your existing WebSocket stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/voice/stream">
      <Parameter name="CallSid" value="${CallSid}"/>
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  return res.send(twiml);
}

// ─── OUTBOUND: Status updates for Telnyx (unchanged) ──────
async function outboundStatusHandler(req, res) {
  try {
    const event = req.body?.data;
    const eventType = event?.event_type;
    const callControlId = event?.payload?.call_control_id;

    if (eventType === 'call.answered') {
      return res.json({
        commands: [{
          command: 'streaming_start',
          params: {
            stream_url: `${process.env.BASE_URL.replace('https', 'wss')}/voice/stream`,
            stream_track: 'both_tracks'
          }
        }]
      });
    }

    if (eventType === 'call.hangup') {
      const callDuration = event.payload?.duration_secs || 0;
      await handleCallEnd(callControlId, callDuration);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('[Outbound Status] Error:', err.message);
    return res.sendStatus(500);
  }
}

// ─── OUTBOUND: Status updates for Twilio (new) ─────────────
async function twilioStatusHandler(req, res) {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    console.log(`[Twilio Status] ${CallSid} → ${CallStatus} (${CallDuration}s)`);

    const terminalStates = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
    if (terminalStates.includes(CallStatus)) {
      await handleCallEnd(CallSid, parseInt(CallDuration || '0'));
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('[Twilio Status] Error:', err.message);
    return res.sendStatus(500);
  }
}

// ─── Shared end-of-call cleanup (unchanged) ───────────────
async function handleCallEnd(callId, durationSecs) {
  try {
    const session = await getSession(callId);
    if (!session) return;

    const minutesUsed = Math.ceil(durationSecs / 60);
    if (minutesUsed > 0) {
      await deductMinutes(session.userId, minutesUsed);
      console.log(`[Call End] User ${session.userId} used ${minutesUsed} min`);
    }

    await destroySession(callId);
  } catch (err) {
    console.error('[Call End] Cleanup error:', err.message);
  }
}

module.exports = { inboundCallHandler, outboundStatusHandler, twilioStatusHandler };