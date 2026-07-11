const axios = require('axios');

const TELNYX_API = 'https://api.telnyx.com/v2';

const telnyxClient = axios.create({
  baseURL: TELNYX_API,
  headers: {
    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

// ─── Make an outbound call ─────────────────────────────────
async function makeOutboundCall(toNumber, fromNumber, tenantId) {
  try {
    const response = await telnyxClient.post('/calls', {
      connection_id: process.env.TELNYX_APP_ID,
      to: toNumber,
      from: fromNumber,
      webhook_url: `${process.env.BASE_URL}/voice/outbound/status`,
      webhook_url_method: 'POST',
      record_audio: false,
      // Pass tenantId in client_state so we can retrieve it in the webhook
      client_state: Buffer.from(JSON.stringify({ tenantId })).toString('base64')
    });

    console.log(`[Telnyx] Outbound call initiated to ${toNumber}`);
    return response.data?.data;
  } catch (err) {
    console.error('[Telnyx] makeOutboundCall error:', err.response?.data || err.message);
    throw err;
  }
}

// ─── Hang up a call ───────────────────────────────────────
async function hangupCall(callControlId) {
  try {
    await telnyxClient.post(`/calls/${callControlId}/actions/hangup`);
  } catch (err) {
    console.error('[Telnyx] hangupCall error:', err.message);
  }
}

module.exports = { makeOutboundCall, hangupCall };
