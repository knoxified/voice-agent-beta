// Signed, call-bound tokens for browser-direct web calls (no Twilio/Telnyx).
//
// The dashboard asks /voice/web-call/start for a token; the browser then opens
// a WebSocket to /voice/stream/:callId?provider=browser&token=... and the
// stream route verifies it BEFORE the call session ever sees the request. The
// userId comes from the verified token, never from anything the browser sends,
// so a caller can't open a call against someone else's account or minutes.
//
// The token only gates CONNECTING. It does not limit how long a call lasts.

const enc = new TextEncoder();

function secretFor(env) {
  // Dedicated secret preferred; falls back to a server-only secret the worker
  // already has so nothing new has to be configured to use this.
  const s = env.WEBCALL_SIGNING_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('No signing secret available for web call tokens');
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

export async function signWebcallToken(env, { userId, callId, systemTypeOverride = '' }, ttlSeconds = 2 * 60 * 60) {
  const payload = {
    u: userId,
    c: callId,
    s: systemTypeOverride || '',
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = toB64Url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env, 'sign'), enc.encode(body)));
  return `${body}.${toB64Url(sig)}`;
}

// Returns { userId, callId, systemTypeOverride } or null if invalid/expired/wrong call.
export async function verifyWebcallToken(env, token, expectedCallId) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env, 'verify'), fromB64Url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64Url(body)));
    if (!p.u || !p.c || p.c !== expectedCallId) return null;
    if (!p.e || p.e < Math.floor(Date.now() / 1000)) return null;
    return { userId: p.u, callId: p.c, systemTypeOverride: p.s || '' };
  } catch {
    return null;
  }
}
