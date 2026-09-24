import { createClient } from '@supabase/supabase-js';

// Sends the due steps of every active email sequence campaign. Runs from the
// Worker's cron trigger (see wrangler.jsonc). All sequence STATE lives in
// Supabase (claim_due_recipients / complete_recipient_send /
// fail_recipient_send in 20260923010000_email_campaigns.sql); this file only
// does the sending. Each email goes out from the customer's OWN connected
// Google mailbox, so one customer's reputation can never affect another's.

const BATCH_SIZE = 15;
const DAILY_CAP_PER_USER = 40;
const GOOGLE_TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// Thrown when the customer's mailbox isn't usable. This is NOT the email's
// fault, so it must not burn one of the recipient's 3 send attempts.
class MailboxUnavailableError extends Error {}

function db(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function stripLineBreaks(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function toBase64Url(str) {
  return toBase64Utf8(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 encoded-word, only when the subject isn't plain ASCII.
function encodeSubject(subject) {
  const clean = stripLineBreaks(subject);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${toBase64Utf8(clean)}?=`;
}

function buildFooter({ senderName, mailingAddress, unsubscribeUrl }) {
  return [
    '',
    '--',
    stripLineBreaks(senderName),
    stripLineBreaks(mailingAddress),
    `Don't want to hear from us? Unsubscribe: ${unsubscribeUrl}`,
  ].join('\n');
}

// Builds the raw RFC 2822 message Gmail's API expects (base64url). From is
// omitted on purpose: Gmail fills in the authenticated mailbox itself.
function buildRawMessage({ to, subject, body, senderName, mailingAddress, unsubscribeUrl }) {
  const headers = [
    `To: ${stripLineBreaks(to)}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `List-Unsubscribe: <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];
  const fullBody = `${String(body ?? '').replace(/\r\n/g, '\n')}\n${buildFooter({ senderName, mailingAddress, unsubscribeUrl })}`;
  const b64 = toBase64Utf8(fullBody).replace(/(.{76})/g, '$1\r\n');
  return toBase64Url(`${headers.join('\r\n')}\r\n\r\n${b64}`);
}

async function getGoogleAccessToken(env, supabase, userId, fetchImpl) {
  const { data: conn, error } = await supabase
    .from('oauth_connections')
    .select('id, access_token, refresh_token, expires_at, status')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Couldn't read mailbox connection: ${error.message}`);
  if (!conn || (conn.status && conn.status !== 'active')) {
    throw new MailboxUnavailableError('Google mailbox is not connected. Connect Google in Integrations to resume sending.');
  }

  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  if (conn.access_token && expiresAt - Date.now() > 60_000) {
    return conn.access_token;
  }

  if (!conn.refresh_token) {
    throw new MailboxUnavailableError('Google connection has no refresh token. Reconnect Google in Integrations.');
  }

  const { data: cfg } = await supabase
    .from('provider_configs')
    .select('client_id, client_secret, token_url')
    .eq('provider', 'google')
    .maybeSingle();
  if (!cfg?.client_id || !cfg?.client_secret) {
    throw new Error('Google OAuth client is not configured.');
  }

  const res = await fetchImpl(cfg.token_url || GOOGLE_TOKEN_URL_DEFAULT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant') {
      throw new MailboxUnavailableError('Google connection expired. Reconnect Google in Integrations to resume sending.');
    }
    throw new Error(`Google token refresh failed (${res.status}): ${json.error || 'unknown'}`);
  }

  await supabase
    .from('oauth_connections')
    .update({
      access_token: json.access_token,
      expires_at: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conn.id);

  return json.access_token;
}

async function sendViaGmail(accessToken, raw, fetchImpl) {
  const res = await fetchImpl(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 401) {
      // Wrong/missing send permission or revoked access: not this email's fault.
      throw new MailboxUnavailableError(
        `Gmail refused to send (${reason}). Reconnect Google in Integrations and allow sending email.`
      );
    }
    throw new Error(`Gmail send failed: ${reason}`);
  }
  return json.id || null;
}

// Mailbox problems push the recipient back 6 hours WITHOUT using up one of
// its 3 attempts, and leave a visible note for the customer.
async function deferRecipient(supabase, recipientId, message) {
  await supabase
    .from('campaign_recipients')
    .update({
      next_send_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
      last_error: String(message).slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', recipientId)
    .eq('status', 'active');
}

async function processDueEmails(env, { supabase = db(env), fetchImpl = fetch } = {}) {
  const { data: due, error } = await supabase.rpc('claim_due_recipients', {
    p_limit: BATCH_SIZE,
    p_daily_cap: DAILY_CAP_PER_USER,
  });
  if (error) {
    console.error('[Email] claim_due_recipients failed:', error.message);
    return { claimed: 0, sent: 0, failed: 0, deferred: 0 };
  }

  const stats = { claimed: due?.length || 0, sent: 0, failed: 0, deferred: 0 };
  const tokenCache = new Map(); // one token lookup per customer per run

  for (const row of due || []) {
    try {
      let tokenPromise = tokenCache.get(row.user_id);
      if (!tokenPromise) {
        tokenPromise = getGoogleAccessToken(env, supabase, row.user_id, fetchImpl);
        tokenCache.set(row.user_id, tokenPromise);
      }
      const accessToken = await tokenPromise;

      const unsubscribeUrl = `${env.BASE_URL}/unsubscribe/${row.unsubscribe_token}`;
      const raw = buildRawMessage({
        to: row.to_email,
        subject: row.subject,
        body: row.body,
        senderName: row.sender_name,
        mailingAddress: row.mailing_address,
        unsubscribeUrl,
      });

      const messageId = await sendViaGmail(accessToken, raw, fetchImpl);
      const { error: doneErr } = await supabase.rpc('complete_recipient_send', {
        p_recipient_id: row.recipient_id,
        p_email_id: row.email_id,
        p_message_id: messageId,
      });
      if (doneErr) console.error('[Email] complete_recipient_send failed:', doneErr.message);
      stats.sent++;
    } catch (err) {
      if (err instanceof MailboxUnavailableError) {
        await deferRecipient(supabase, row.recipient_id, err.message);
        stats.deferred++;
      } else {
        console.error(`[Email] send failed for recipient ${row.recipient_id}:`, err.message);
        await supabase.rpc('fail_recipient_send', {
          p_recipient_id: row.recipient_id,
          p_email_id: row.email_id,
          p_error: err.message,
        });
        stats.failed++;
      }
    }
  }

  console.log('[Email] run complete', JSON.stringify(stats));
  return stats;
}

async function unsubscribeByToken(env, token) {
  const { data, error } = await db(env).rpc('unsubscribe_recipient', { p_token: token });
  if (error) {
    console.error('[Email] unsubscribe_recipient failed:', error.message);
    return null;
  }
  return data === true;
}

export {
  processDueEmails,
  unsubscribeByToken,
  buildRawMessage,
  encodeSubject,
  MailboxUnavailableError,
};
