import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mintVoiceAccessToken } from './services/twilioToken.js';
import { getUserById, getUserByPhone, checkQuota } from './services/supabase.js';
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonnet-1',
        voice: { id: c.env.CARTESIA_VOICE_ID_DEFAULT || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b' },
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

  const quotaOk = await checkQuota(c.env, userId);
  if (!quotaOk) {
    return c.json({ error: 'quota_exceeded' }, 402);
  }

  const token = await mintVoiceAccessToken(c.env, userId);
  return c.json({ token });
});

app.post('/voice/web-call/start', async (c) => {
  const { userId } = await c.req.json().catch(() => ({}));
  if (!userId) return c.json({ error: 'missing_userId' }, 400);

  const user = await getUserById(c.env, userId);
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const quotaOk = await checkQuota(c.env, userId);
  if (!quotaOk) return c.json({ error: 'quota_exceeded' }, 402);

  return c.json({ ready: true });
});

app.post('/twiml/web-call', async (c) => {
  const body = await c.req.parseBody();
  const callSid = body.CallSid;
  const from = body.From || '';
  const userId = from.replace(/^client:/, '');

  if (!userId || !callSid) {
    return twimlResponse(sayAndHangup("Sorry, we couldn't identify your account. Goodbye."));
  }

  const user = await getUserById(c.env, userId);
  if (!user) {
    return twimlResponse(sayAndHangup('Account not found. Goodbye.'));
  }

  const quotaOk = await checkQuota(c.env, userId);
  if (!quotaOk) {
    return twimlResponse(sayAndHangup('Sorry, your minutes have been exhausted. Please upgrade your plan.'));
  }

  const host = new URL(c.req.url).host;
  const streamUrl = `wss://${host}/voice/stream/${callSid}?userId=${encodeURIComponent(userId)}&provider=web`;

  return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
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

async function handleTwilioInbound(c, body) {
  const { CallSid, From, To } = body;
  console.log(`[Twilio] Inbound call from ${From} to ${To} | SID: ${CallSid}`);

  const user = await getUserByPhone(c.env, To);
  if (!user) {
    return twimlResponse(sayAndHangup('This number is not currently in service. Goodbye.'));
  }

  const quotaOk = await checkQuota(c.env, user.id);
  if (!quotaOk) {
    return twimlResponse(sayAndHangup('Sorry, your minutes have been exhausted. Please upgrade your plan.'));
  }

  const host = new URL(c.req.url).host;
  const streamUrl =
    `wss://${host}/voice/stream/${CallSid}` +
    `?userId=${encodeURIComponent(user.id)}&callerNumber=${encodeURIComponent(From)}&provider=twilio`;

  return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
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

    console.log(`[Telnyx] Inbound call from ${fromNumber} to ${toNumber}`);

    const user = await getUserByPhone(c.env, toNumber);
    if (!user) {
      return c.json({
        commands: [{ command: 'speak', params: { payload: 'This number is not currently in service. Goodbye.', voice: 'en-US-Neural2-F', language: 'en-US' } }],
      });
    }

    const quotaOk = await checkQuota(c.env, user.id);
    if (!quotaOk) {
      return c.json({
        commands: [{ command: 'speak', params: { payload: 'Sorry, your minutes have been exhausted. Please upgrade your plan.', voice: 'en-US-Neural2-F', language: 'en-US' } }],
      });
    }

    return c.json({
      commands: [{ command: 'answer', params: {}, client_state: btoa(JSON.stringify({ userId: user.id, callerNumber: fromNumber })) }],
    });
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

    return c.json({
      commands: [{ command: 'streaming_start', params: { stream_url: streamUrl, stream_track: 'both_tracks' } }],
    });
  }

  return c.text('', 200);
}

app.get('/voice/stream/:callId', async (c) => {
  const callId = c.req.param('callId');
  const id = c.env.CALL_SESSION.idFromName(callId);
  const stub = c.env.CALL_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

function sayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">${escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
