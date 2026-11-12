// Cron helpers that ask the dashboard Worker (service binding, no public URL) to run
// number housekeeping. Tokens are derived from the service-role key both Workers already hold.
import { sendNumberReadyEmail } from './brevo.js';

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sbHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

async function callDashboard(env, path, purpose) {
  const token = await sha256Hex(`${env.SUPABASE_SERVICE_ROLE_KEY}:${purpose}`);
  return env.DASHBOARD.fetch(`https://dashboard.internal${path}`, { method: 'POST', headers: { 'x-cron-token': token } });
}

// Retry paused purchases (only when some exist), then email each customer whose number is ready.
export async function kickNumberRetries(env) {
  if (!env.DASHBOARD || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/number_purchases?status=eq.paused_low_balance&select=id&limit=1`, { headers: sbHeaders(env) });
    if (!res.ok) return;
    const waiting = await res.json();
    if (!Array.isArray(waiting) || waiting.length === 0) return; // idle: one tiny query

    const out = await callDashboard(env, '/api/internal/retry-number-purchases', 'number-retry');
    console.log(`[NumberRetry] dashboard responded ${out.status}`);
    if (!out.ok) return;
    const { completed } = await out.json();
    for (const item of completed || []) {
      try {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${item.user_id}&select=email`, { headers: sbHeaders(env) });
        const email = r.ok ? (await r.json())?.[0]?.email : null;
        await sendNumberReadyEmail(env, { toEmail: email, number: item.number });
      } catch (err) {
        console.error('[NumberRetry] ready email failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[NumberRetry] failed:', err.message);
  }
}

// Once a day (03:00 UTC window): give back numbers of customers who stopped paying 14+ days ago.
export async function kickNumberRelease(env, now = new Date()) {
  if (!env.DASHBOARD || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  if (now.getUTCHours() !== 3 || now.getUTCMinutes() >= 10) return;
  try {
    const out = await callDashboard(env, '/api/internal/release-lapsed-numbers', 'number-release');
    console.log(`[NumberRelease] dashboard responded ${out.status}`);
  } catch (err) {
    console.error('[NumberRelease] failed:', err.message);
  }
}
