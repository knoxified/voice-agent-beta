// Every cron run: if any customer number purchase is waiting (provider account not ready or
// out of funds), ask the dashboard Worker to retry it. Uses a service binding, so no public URL.
// The token is derived from the service-role key both Workers already hold.
async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function kickNumberRetries(env) {
  if (!env.DASHBOARD || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/number_purchases?status=eq.paused_low_balance&select=id&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) return;
    const waiting = await res.json();
    if (!Array.isArray(waiting) || waiting.length === 0) return; // idle: costs one tiny query

    const token = await sha256Hex(`${env.SUPABASE_SERVICE_ROLE_KEY}:number-retry`);
    const out = await env.DASHBOARD.fetch('https://dashboard.internal/api/internal/retry-number-purchases', {
      method: 'POST',
      headers: { 'x-cron-token': token },
    });
    console.log(`[NumberRetry] dashboard responded ${out.status}`);
  } catch (err) {
    console.error('[NumberRetry] failed:', err.message);
  }
}
