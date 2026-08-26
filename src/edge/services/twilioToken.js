// Twilio Access Tokens are just JWTs with a specific structure and an
// HMAC-SHA256 signature. Hand-rolled here with Workers' native
// crypto.subtle instead of the `twilio` npm package, so there's no
// Node.js-compatibility question at all -- this is pure Web Crypto API,
// which Workers supports natively.
//
// Structure reference: https://www.twilio.com/docs/iam/access-tokens

function base64url(input) {
  let base64;
  if (typeof input === 'string') {
    base64 = btoa(input);
  } else {
    // ArrayBuffer -> base64
    const bytes = new Uint8Array(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
}

/**
 * Mints a Twilio Voice Access Token for the browser SDK.
 *
 * @param {object} env - Workers env bindings (needs TWILIO_ACCOUNT_SID,
 *   TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID)
 * @param {string} identity - Usually the Supabase user_id, so the TwiML
 *   webhook can identify who's calling without a phone-number lookup.
 * @param {number} ttlSeconds - Token lifetime, default 1 hour.
 */
async function mintVoiceAccessToken(env, identity, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);

  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${env.TWILIO_API_KEY}-${now}`,
    iss: env.TWILIO_API_KEY,
    sub: env.TWILIO_ACCOUNT_SID,
    exp: now + ttlSeconds,
    grants: {
      identity,
      voice: {
        outgoing: { application_sid: env.TWILIO_TWIML_APP_SID },
        incoming: { allow: true },
      },
    },
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  const signature = await hmacSha256(env.TWILIO_API_SECRET, unsigned);
  const encodedSignature = base64url(signature);

  return `${unsigned}.${encodedSignature}`;
}

export { mintVoiceAccessToken };
