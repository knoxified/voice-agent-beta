// Inbound webhook authentication for /voice/inbound.
// WEBHOOK_AUTH_MODE: 'off' | 'log' (default: check and log, never block) | 'enforce' (block bad requests).
// Keys are optional: with no key configured for a provider the check is skipped, so nothing
// breaks before you add them.
//   TELNYX_PUBLIC_KEY       Telnyx portal > Keys & Credentials > Public Key (base64)
//   SIGNALWIRE_SIGNING_KEY  SignalWire dashboard > API > Signing Key
//   TWILIO_AUTH_TOKEN       (existing Twilio number)

const enc = new TextEncoder();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function webhookAuthMode(env) {
  const m = (env.WEBHOOK_AUTH_MODE || 'log').toLowerCase();
  return ['off', 'log', 'enforce'].includes(m) ? m : 'log';
}

export async function verifyTelnyx(env, headers, rawBody) {
  if (!env.TELNYX_PUBLIC_KEY) return { ok: true, skipped: true };
  const sig = headers.get('telnyx-signature-ed25519');
  const ts = headers.get('telnyx-timestamp');
  if (!sig || !ts) return { ok: false, reason: 'missing signature headers' };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { ok: false, reason: 'stale timestamp' };
  try {
    const key = await crypto.subtle.importKey('raw', b64ToBytes(env.TELNYX_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', key, b64ToBytes(sig), enc.encode(`${ts}|${rawBody}`));
    return ok ? { ok: true } : { ok: false, reason: 'bad signature' };
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
}

// Twilio-style scheme, used by Twilio and SignalWire (cXML):
// base64(HMAC-SHA1(secret, fullUrl + each param name+value, names sorted)).
export async function verifyTwilioStyle(env, headers, url, params) {
  const swSig = headers.get('x-signalwire-signature');
  const sig = swSig || headers.get('x-twilio-signature');
  const secret = swSig ? env.SIGNALWIRE_SIGNING_KEY : env.TWILIO_AUTH_TOKEN;
  if (!secret) return { ok: true, skipped: true };
  if (!sig) return { ok: false, reason: 'missing signature header' };

  let data = url;
  for (const k of Object.keys(params).sort()) data += k + (params[k] ?? '');
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
    let bin = '';
    for (const b of mac) bin += String.fromCharCode(b);
    return safeEqual(btoa(bin), sig) ? { ok: true } : { ok: false, reason: 'bad signature' };
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
}
