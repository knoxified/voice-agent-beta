const TIMEOUT_MS = 12000; // booking can include an OAuth refresh; the agent speaks a filler line while waiting

function webhookMap(env) {
  return {
    book_appointment: env.N8N_WEBHOOK_BOOK || 'webhook/appointment-webhook',
    check_availability: env.N8N_WEBHOOK_BOOK || 'webhook/appointment-webhook',
    leadreach: env.N8N_WEBHOOK_LEADREACH || 'webhook/leadreach',
  };
}

async function triggerAutomation(env, intentType, payload) {
  const webhookPath = webhookMap(env)[intentType];
  if (!webhookPath) {
    console.warn(`[n8n] No webhook mapped for intent: ${intentType}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${env.N8N_BASE_URL}/${webhookPath}`;
    console.log(`[n8n] Triggering ${intentType} → ${url}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);
    console.log(`[n8n] ${intentType} -> HTTP ${res.status}`, JSON.stringify(data)?.slice(0, 300));
    return data;
  } catch (err) {
    // Don't crash the call if n8n fails -- the AI handles it gracefully.
    console.error(`[n8n] Automation failed for ${intentType}:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export { triggerAutomation };
