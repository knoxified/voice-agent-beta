const axios = require('axios');

const N8N_BASE = process.env.N8N_BASE_URL;
const TIMEOUT = 8000; // n8n must respond within 8 seconds during a call

const WEBHOOK_MAP = {
  book_appointment: process.env.N8N_WEBHOOK_BOOK || 'webhook/appointment-webhook',
  check_availability: process.env.N8N_WEBHOOK_BOOK || 'webhook/appointment-webhook',
  leadreach: process.env.N8N_WEBHOOK_LEADREACH || 'webhook/leadreach'
};

// ─── Fire n8n webhook and return result ───────────────────
async function triggerAutomation(intentType, payload) {
  const webhookPath = WEBHOOK_MAP[intentType];
  if (!webhookPath) {
    console.warn(`[n8n] No webhook mapped for intent: ${intentType}`);
    return null;
  }

  try {
    const url = `${N8N_BASE}/${webhookPath}`;
    console.log(`[n8n] Triggering ${intentType} → ${url}`);

    const response = await axios.post(url, payload, {
      timeout: TIMEOUT,
      headers: { 'Content-Type': 'application/json' }
    });

    console.log(`[n8n] Response for ${intentType}:`, response.data);
    return response.data;

  } catch (err) {
    // Don't crash the call if n8n fails
    // The AI will handle it gracefully in its response
    console.error(`[n8n] Automation failed for ${intentType}:`, err.message);
    return null;
  }
}

module.exports = { triggerAutomation };
