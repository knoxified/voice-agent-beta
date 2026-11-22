// SignalWire live-call transfer (cXML <Dial>).
//
// SignalWire's "Update a Call" REST endpoint redirects an in-progress call to
// new cXML fetched from a URL (it does not take inline XML). So a transfer is:
//   1. signalwireTransfer() signs a short-lived token (bound to this CallSid and
//      the destination) and tells SignalWire to fetch /voice/transfer-twiml?t=...
//   2. that route verifies the token and answers with the <Dial> below.
// The caller's <Connect><Stream> ends when SignalWire runs the new instructions.
//
// Secrets needed on THIS (voice agent) Worker, same ones the dashboard has:
//   SIGNALWIRE_SPACE_URL, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN
// Optional: TRANSFER_SIGNING_SECRET (falls back to a secret the Worker already has).

const enc = new TextEncoder();

function secretFor(env) {
  const s = env.TRANSFER_SIGNING_SECRET || env.WEBCALL_SIGNING_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('No signing secret available for transfer tokens');
  return s;
}

function toB64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(env, usage) {
  return crypto.subtle.importKey('raw', enc.encode(secretFor(env)), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signTransferToken(env, { callSid, to }, ttlSeconds = 120) {
  const payload = { c: callSid, t: to, e: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = toB64Url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env, 'sign'), enc.encode(body)));
  return `${body}.${toB64Url(sig)}`;
}

// Returns { to } or null if the token is invalid, expired, or for a different call.
export async function verifyTransferToken(env, token, expectedCallSid) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env, 'verify'), fromB64Url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64Url(body)));
    if (!p.c || !p.t || p.c !== expectedCallSid) return null;
    if (!p.e || p.e < Math.floor(Date.now() / 1000)) return null;
    return { to: p.t };
  } catch {
    return null;
  }
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// The caller ID shown to the person being rung is left to SignalWire's default
// (the original caller). Set SIGNALWIRE_TRANSFER_CALLER_ID to one of your own
// SignalWire numbers if a carrier rejects the original caller's number.
export function transferTwiml(env, to) {
  const callerId = env.SIGNALWIRE_TRANSFER_CALLER_ID
    ? ` callerId="${escapeXml(env.SIGNALWIRE_TRANSFER_CALLER_ID)}"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="30"${callerId}>${escapeXml(to)}</Dial>
  <Say voice="Polly.Amy">Sorry, we couldn't connect your call. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// Same return shape as telnyxAction: { ok: true } or { ok: false, error }.
export async function signalwireTransfer(env, callSid, to) {
  const space = (env.SIGNALWIRE_SPACE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const project = env.SIGNALWIRE_PROJECT_ID;
  const token = env.SIGNALWIRE_API_TOKEN;
  if (!space || !project || !token || !env.BASE_URL) {
    console.error('[SignalWire] Missing SIGNALWIRE_* credentials or BASE_URL -- cannot transfer.');
    return { ok: false, error: 'missing_credentials' };
  }
  if (!callSid) return { ok: false, error: 'missing_call_sid' };

  const t = await signTransferToken(env, { callSid, to });
  const url = `${env.BASE_URL}/voice/transfer-twiml?t=${encodeURIComponent(t)}`;

  const res = await fetch(`https://${space}/api/laml/2010-04-01/Accounts/${project}/Calls/${callSid}.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${project}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Url: url, Method: 'POST' }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[SignalWire] transfer failed (${res.status}) for ${callSid}: ${errText}`);
    return { ok: false, error: errText, status: res.status };
  }
  return { ok: true };
}
