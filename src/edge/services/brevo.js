/**
 * Sends a demo booking confirmation email via Brevo's REST API.
 * Raw SMTP (port 587) is not supported in Cloudflare Workers — Brevo's
 * v3 HTTP API does the same job without a TCP socket.
 *
 * Requires env.BREVO_API_KEY (set as a Cloudflare secret, never committed).
 */

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

const INDUSTRY_LABELS = {
  dental: 'Dental Practice',
  'real-estate': 'Real Estate Agency',
  healthcare: 'Healthcare Practice',
  fitness: 'Fitness Business',
  legal: 'Law Firm',
  hotel: 'Hotel & Hospitality',
};

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

function buildEmailHtml({ toName, industry, startTime }) {
  const industryLabel = INDUSTRY_LABELS[industry] || 'Business';
  const timeStr = formatTime(startTime);
  const firstName = (toName || 'there').split(' ')[0];

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#0ea5e9,#3b82f6);padding:32px 40px;">
            <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Knoxified</p>
            <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.75);">AI Voice Agents for Business</p>
          </td>
        </tr>

        <!-- Confirmation badge -->
        <tr>
          <td align="center" style="padding:32px 40px 0;">
            <div style="display:inline-block;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:999px;padding:8px 20px;">
              <span style="color:#059669;font-weight:600;font-size:14px;">✓ &nbsp;Appointment Confirmed</span>
            </div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 40px 0;">
            <p style="margin:0 0 16px;font-size:16px;color:#0f172a;">Hi ${firstName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
              You're all set. Here are your appointment details:
            </p>

            <!-- Appointment card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:12px;margin-bottom:24px;">
              <tr>
                <td style="padding:20px 24px;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;">Date &amp; Time</p>
                  <p style="margin:0;font-size:16px;font-weight:600;color:#0f172a;">${timeStr}</p>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
              A calendar invitation has been sent separately. You'll hear from us closer to the time.
            </p>

            <!-- Divider -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td style="border-top:1px solid #e2e8f0;"></td></tr>
            </table>

            <!-- CTA section -->
            <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">
              The agent you just spoke with is a live demo.
            </p>
            <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">
              Your own version — trained on your ${industryLabel}, your availability, your brand voice — can answer every call, 24/7, just like that. No scripts, no hold music.
            </p>

            <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
              <tr>
                <td style="background:linear-gradient(135deg,#00e5ff,#3b82f6);border-radius:10px;">
                  <a href="https://knoxified.org/get-started" style="display:block;padding:14px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">
                    Get your own AI agent &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:0 40px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="border-top:1px solid #e2e8f0;padding-top:20px;">
                <p style="margin:0;font-size:13px;color:#94a3b8;">
                  Knoxified &middot; AI Voice Agents &middot;
                  <a href="https://knoxified.org" style="color:#0ea5e9;text-decoration:none;">knoxified.org</a>
                </p>
              </td></tr>
            </table>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendDemoBookingEmail(env, { toEmail, toName, industry, startTime }) {
  if (!env.BREVO_API_KEY || !toEmail) return;

  const htmlContent = buildEmailHtml({ toName, industry, startTime });

  const res = await fetch(BREVO_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        email: env.BREVO_SENDER_EMAIL || 'no-reply@mail.knoxified.org',
        name: env.BREVO_SENDER_NAME || 'Knoxified',
      },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject: 'Your Knoxified demo appointment is confirmed ✓',
      htmlContent,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (${res.status}): ${body}`);
  }

  console.log(`[Demo] Booking confirmation sent to ${toEmail}`);
}
