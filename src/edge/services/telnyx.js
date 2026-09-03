// Telnyx's Call Control API is NOT like Twilio's TwiML: returning a JSON
// body from the webhook handler does nothing to the call. Every action
// (answer, speak, hangup, streaming_start, ...) has to be a separate
// authenticated REST call back to Telnyx, referencing the call_control_id
// from the webhook payload. Docs: developers.telnyx.com/docs/api/v2/call-control
//
// Requires TELNYX_API_KEY (Bearer token) set as a Workers secret --
// `wrangler secret put TELNYX_API_KEY` -- found in the Telnyx portal under
// Auth v2 / API Keys.
async function telnyxAction(env, callControlId, action, body = {}) {
  if (!env.TELNYX_API_KEY) {
    console.error('[Telnyx] TELNYX_API_KEY is not set -- cannot control calls.');
    return { ok: false, error: 'missing_api_key' };
  }

  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[Telnyx] ${action} failed (${res.status}) for ${callControlId}: ${errText}`);
    return { ok: false, error: errText, status: res.status };
  }
  return { ok: true, data: await res.json().catch(() => null) };
}

const telnyxAnswer = (env, callControlId, opts = {}) => telnyxAction(env, callControlId, 'answer', opts);
const telnyxSpeak = (env, callControlId, payload, opts = {}) =>
  telnyxAction(env, callControlId, 'speak', { payload, voice: 'female', language_code: 'en-US', ...opts });
const telnyxHangup = (env, callControlId, opts = {}) => telnyxAction(env, callControlId, 'hangup', opts);
const telnyxStreamingStart = (env, callControlId, streamUrl, opts = {}) =>
  telnyxAction(env, callControlId, 'streaming_start', { stream_url: streamUrl, stream_track: 'both_tracks', ...opts });

export { telnyxAction, telnyxAnswer, telnyxSpeak, telnyxHangup, telnyxStreamingStart };
