import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mintVoiceAccessToken } from './services/twilioToken.js';
import { telnyxAnswer, telnyxSpeak, telnyxHangup, telnyxStreamingStart } from './services/telnyx.js';
import { getUserById, getUserByPhone, checkQuota, logUnmatchedInboundCall, getUserVoiceSettings, getAgentConfig, saveCallRecordingUrl } from './services/supabase.js';
import { synthesizeSpeech } from './services/tts.js';
import { buildGreeting } from './services/greeting.js';
import { createClient } from '@supabase/supabase-js';
import { CallSession } from './durable_objects/CallSession.js';

export { CallSession };

const app = new Hono();

app.use('/*', cors({
  origin: 'https://dashboard.knoxified.org',
  allowMethods: ['GET', 'POST'],
}));

app.get('/', (c) => c.json({ status: 'Knoxified Voice Agent running (Cloudflare Workers)' }));

app.get('/test-do', async (c) => {
  const id = c.env.CALL_SESSION.idFromName('test-session');
  const stub = c.env.CALL_SESSION.get(id);
  const res = await stub.fetch(new Request('https://voice.knoxified.org/test'));
  const text = await res.text();
  return new Response(text, { headers: { 'Content-Type': 'application/json' } });
});

app.get('/test', async (c) => {
  const results = {};

  try {
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3', {
      headers: { Authorization: `Token ${c.env.DEEPGRAM_API_KEY}` },
    });
    results.deepgram = res.ok ? 'OK' : `FAILED (${res.status})`;
  } catch (e) {
    results.deepgram = `ERROR: ${e.message}`;
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${c.env.GROQ_API_KEY}` },
    });
    results.groq = res.ok ? 'OK' : `FAILED (${res.status})`;
  } catch (e) {
    results.groq = `ERROR: ${e.message}`;
  }

  try {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': c.env.CARTESIA_API_KEY,
        'Cartesia-Version': '2026-03-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: c.env.CARTESIA_MODEL_ID || 'sonic-3',
        voice: { mode: 'id', id: c.env.CARTESIA_VOICE_ID_DEFAULT || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b' },
        transcript: 'test',
      }),
    });
    results.cartesia = res.ok ? 'OK' : `FAILED (${res.status})`;
  } catch (e) {
    results.cartesia = `ERROR: ${e.message}`;
  }

  try {
    const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/users?limit=1`, {
      headers: {
        apikey: c.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    results.supabase = res.ok ? 'OK' : `FAILED (${res.status})`;
  } catch (e) {
    results.supabase = `ERROR: ${e.message}`;
  }

  return c.json(results);
});

app.post('/voice/token', async (c) => {
  const { userId } = await c.req.json().catch(() => ({}));
  if (!userId) return c.json({ error: 'missing_userId' }, 400);

  const user = await getUserById(c.env, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const quota = await checkQuota(c.env, userId);
  if (!quota.ok) {
    return c.json({ error: 'quota_exceeded', message: quota.message }, 402);
  }

  const token = await mintVoiceAccessToken(c.env, userId);
  return c.json({ token });
});

// Lets a client hear their actual configured agent (voice, name, company)
// before ever touching a phone number -- a cold prospect's first real
// question is "does this sound competent," and until now there was no way
// to answer that without going through the full phone-forwarding setup.
// Auth is a verified Supabase JWT (not a client-supplied user id) so this
// can't be used to generate free TTS against someone else's account.
app.post('/voice/preview', async (c) => {
  const authHeader = c.req.header('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return c.json({ error: 'not_authenticated' }, 401);

  const verifyClient = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authError } = await verifyClient.auth.getUser(token);
  if (authError || !user) return c.json({ error: 'not_authenticated' }, 401);

  const [voiceSettings, agentConfig] = await Promise.all([
    getUserVoiceSettings(c.env, user.id),
    getAgentConfig(c.env, user.id),
  ]);

  const previewText = buildGreeting(agentConfig, voiceSettings?.agent_greeting, false, agentConfig?.require_ai_disclosure !== false);

  try {
    const audio = await synthesizeSpeech(c.env, previewText, voiceSettings?.preferred_voice_id, 'mp3');
    if (!audio) return c.json({ error: 'synthesis_failed' }, 500);
    return new Response(audio, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[voice/preview] error:', err.message);
    return c.json({ error: 'synthesis_failed' }, 500);
  }
});

app.post('/voice/web-call/start', async (c) => {
  const { userId } = await c.req.json().catch(() => ({}));
  if (!userId) return c.json({ error: 'missing_userId' }, 400);

  const user = await getUserById(c.env, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const quota = await checkQuota(c.env, userId);
  if (!quota.ok) return c.json({ error: 'quota_exceeded', message: quota.message }, 402);

  return c.json({ ready: true });
});

app.post('/twiml/web-call', async (c) => {
  const body = await c.req.parseBody();
  const callSid = body.CallSid;
  const from = body.From || '';
  const userId = from.replace(/^client:/, '');
  // Lets the per-system preview widget hear a DIFFERENT vertical's
  // tone/temperature than the account's own configured system_type,
  // without changing their real settings. Passed through device.connect's
  // params, arrives here the same way CallSid/From do.
  const systemTypeOverride = typeof body.systemTypeOverride === 'string' ? body.systemTypeOverride : '';

  if (!userId || !callSid) {
    return twimlResponse(sayAndHangup("Sorry, we couldn't identify your account. Goodbye."));
  }

  const user = await getUserById(c.env, userId);
  if (!user) {
    return twimlResponse(sayAndHangup('Account not found. Goodbye.'));
  }

  const quota = await checkQuota(c.env, userId);
  if (!quota.ok) {
    return twimlResponse(sayAndHangup(quota.message));
  }

  const host = new URL(c.req.url).host;
  const streamUrl = `wss://${host}/voice/stream/${callSid}?userId=${encodeURIComponent(userId)}&provider=web`;

  return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">
      <Parameter name="userId" value="${escapeXml(userId)}" />
      <Parameter name="provider" value="web" />
      ${systemTypeOverride ? `<Parameter name="systemTypeOverride" value="${escapeXml(systemTypeOverride)}" />` : ''}
    </Stream>
  </Connect>
</Response>`);
});

app.post('/voice/inbound', async (c) => {
  const body = await parseInboundBody(c.req);

  const isTwilio = !!(body.CallSid && body.From);
  const isTelnyx = !!(body?.data?.event_type);

  if (isTwilio) return handleTwilioInbound(c, body);
  if (isTelnyx) return handleTelnyxInbound(c, body);

  console.warn('[Inbound] Unknown webhook format');
  return c.text('', 400);
});

// Twilio calls this once a started recording finishes processing --
// recording completion happens well after the call itself ends, so this
// almost always arrives after saveCallTranscript already created the row
// (see the upsert-safe write pattern in supabase.js).
app.post('/voice/recording-status', async (c) => {
  const body = await parseInboundBody(c.req);
  const callSid = body.CallSid;
  const recordingUrl = body.RecordingUrl;
  const status = body.RecordingStatus;

  if (status === 'completed' && callSid && recordingUrl) {
    // Twilio's RecordingUrl needs ".mp3" appended to fetch the actual audio
    // file (the bare URL returns recording metadata, not audio).
    await saveCallRecordingUrl(c.env, callSid, `${recordingUrl}.mp3`);
  } else {
    console.log(`[Twilio] Recording status '${status}' for ${callSid} -- not storing`);
  }

  return c.text('', 200);
});

async function handleTwilioInbound(c, body) {
  const { CallSid, From, To, ForwardedFrom } = body;
  const lookupNumber = resolveDialedNumber({ to: To, forwardedFrom: ForwardedFrom });
  console.log(`[Twilio] Inbound call from ${From} to ${To} (lookup: ${lookupNumber}) | SID: ${CallSid}`);

  const user = await getUserByPhone(c.env, lookupNumber);
  if (!user) {
    // Shared-number call-forwarding setup: this fires whenever we can't
    // tell which client's forwarded business number this call was
    // originally dialed to. Logged so the real Twilio payload can be
    // inspected (see phone_number_mappings / ForwardedFrom docs) rather
    // than guessing further blind.
    await logUnmatchedInboundCall(c.env, body, lookupNumber);
    return twimlResponse(sayAndHangup('This number is not currently in service. Goodbye.'));
  }

  const quota = await checkQuota(c.env, user.id);
  if (!quota.ok) {
    return twimlResponse(sayAndHangup(quota.message));
  }

  const agentConfig = await getAgentConfig(c.env, user.id);
  if (agentConfig?.call_recording_enabled) {
    const host = new URL(c.req.url).host;
    const statusCallbackUrl = `https://${host}/voice/recording-status`;
    // Fired in the background -- Twilio's Call Recording Controls API works
    // concurrently with an active <Connect><Stream> call (confirmed via
    // Twilio's own docs), so this doesn't block or interfere with the TwiML
    // response below.
    c.executionCtx.waitUntil(startTwilioRecording(c.env, CallSid, statusCallbackUrl));
  }

  const host = new URL(c.req.url).host;
  const streamUrl =
    `wss://${host}/voice/stream/${CallSid}` +
    `?userId=${encodeURIComponent(user.id)}&callerNumber=${encodeURIComponent(From)}&provider=twilio`;

  return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">
      <Parameter name="userId" value="${escapeXml(user.id)}" />
      <Parameter name="callerNumber" value="${escapeXml(From)}" />
      <Parameter name="provider" value="twilio" />
    </Stream>
  </Connect>
</Response>`);
}

async function handleTelnyxInbound(c, body) {
  const event = body.data;
  const eventType = event?.event_type;

  if (eventType === 'call.initiated') {
    const callControlId = event.payload?.call_control_id;
    const toNumber = event.payload?.to;
    const fromNumber = event.payload?.from;
    // Shared-number call-forwarding setup: when a client forwards their own
    // business number to our one Telnyx number, `to` above is OUR number,
    // not theirs -- it tells us nothing about which client this is. If the
    // client's carrier passed SHAKEN/STIR diversion info through, Telnyx
    // may expose it under one of these fields (not fully confirmed against
    // a live payload yet -- see logUnmatchedInboundCall below).
    const divertedNumber =
      event.payload?.diversion?.diverting_number ||
      event.payload?.custom_headers?.find?.((h) => /^diversion$/i.test(h.name))?.value ||
      event.payload?.custom_headers?.find?.((h) => /^history-info$/i.test(h.name))?.value ||
      null;
    const lookupNumber = resolveDialedNumber({ to: toNumber, forwardedFrom: divertedNumber });

    console.log(`[Telnyx] Inbound call from ${fromNumber} to ${toNumber} (lookup: ${lookupNumber})`);

    const user = await getUserByPhone(c.env, lookupNumber);
    if (!user) {
      await logUnmatchedInboundCall(c.env, event, lookupNumber);
      // Must answer before we can speak -- Telnyx won't play audio on an
      // unanswered call.
      await telnyxAnswer(c.env, callControlId);
      await telnyxSpeak(c.env, callControlId, 'This number is not currently in service. Goodbye.');
      await telnyxHangup(c.env, callControlId);
      return c.text('', 200);
    }

    const quota = await checkQuota(c.env, user.id);
    if (!quota.ok) {
      await telnyxAnswer(c.env, callControlId);
      await telnyxSpeak(c.env, callControlId, quota.message);
      await telnyxHangup(c.env, callControlId);
      return c.text('', 200);
    }

    // client_state rides along on every future webhook for this call
    // (Telnyx echoes it back), so call.answered below can recover which
    // user/caller this is without a second DB lookup.
    await telnyxAnswer(c.env, callControlId, {
      client_state: btoa(JSON.stringify({ userId: user.id, callerNumber: fromNumber })),
    });
    return c.text('', 200);
  }

  if (eventType === 'call.answered') {
    const callControlId = event.payload?.call_control_id;
    const clientState = event.payload?.client_state;
    let userId = '';
    let callerNumber = '';
    try {
      const parsed = JSON.parse(atob(clientState));
      userId = parsed.userId;
      callerNumber = parsed.callerNumber;
    } catch {
      console.error('[Telnyx] Missing/invalid client_state on call.answered');
    }

    const host = new URL(c.req.url).host;
    const streamUrl =
      `wss://${host}/voice/stream/${callControlId}` +
      `?userId=${encodeURIComponent(userId)}&callerNumber=${encodeURIComponent(callerNumber)}&provider=telnyx`;

    const result = await telnyxStreamingStart(c.env, callControlId, streamUrl);
    if (!result.ok) {
      // We already answered the call -- if streaming fails to start the
      // caller would otherwise sit in silence forever, so hang up cleanly
      // instead of leaving a dead-air call running up minutes.
      await telnyxHangup(c.env, callControlId).catch(() => {});
    }
    return c.text('', 200);
  }

  return c.text('', 200);
}

app.get('/voice/stream/:callId', async (c) => {
  const callId = c.req.param('callId');
  const id = c.env.CALL_SESSION.idFromName(callId);
  const stub = c.env.CALL_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

// Prefer the originally-dialed number a carrier passed through on a
// forwarded call (ForwardedFrom on Twilio, diversion info on Telnyx) over
// the raw `to`, since with one shared number `to` is always OUR number
// and can't tell clients apart. Falls back to `to` unchanged for clients
// who still have their own dedicated number.
// Twilio's Call Recording Controls API -- starts recording an already-
// in-progress call via a separate REST call, independent of the
// <Connect><Stream> TwiML already driving the live AI conversation.
// Confirmed via Twilio's own docs this works concurrently with Media
// Streams (no <Dial>/<Record> verb needed). Uses the same API Key/Secret
// already configured for minting Voice SDK tokens (twilioToken.js) --
// Twilio accepts API Key SID/Secret as Basic Auth credentials for the
// REST API, scoped the same as the main Account SID.
async function startTwilioRecording(env, callSid, statusCallbackUrl) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY || !env.TWILIO_API_SECRET) {
    console.error('[Twilio] Missing credentials -- cannot start recording.');
    return;
  }
  try {
    const auth = btoa(`${env.TWILIO_API_KEY}:${env.TWILIO_API_SECRET}`);
    const body = new URLSearchParams({
      RecordingStatusCallback: statusCallbackUrl,
      RecordingStatusCallbackEvent: 'completed',
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[Twilio] startRecording failed (${res.status}) for ${callSid}: ${errText}`);
    } else {
      console.log(`[Twilio] Recording started for call ${callSid}`);
    }
  } catch (err) {
    console.error('[Twilio] startRecording error:', err.message);
  }
}

function resolveDialedNumber({ to, forwardedFrom }) {
  return forwardedFrom || to;
}

function sayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">${escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlResponse(xml) {
  return new Response(xml, { headers: { 'Content-Type': 'text/xml' } });
}

async function parseInboundBody(req) {
  const contentType = req.header('content-type') || '';
  if (contentType.includes('application/json')) {
    return req.json();
  }
  const form = await req.parseBody();
  return form;
}

export default app;
