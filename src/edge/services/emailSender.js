import { createClient } from '@supabase/supabase-js';

// Sends the due steps of every active email sequence campaign. Runs from the
// Worker's cron trigger (see wrangler.jsonc). All sequence STATE lives in
// Supabase (claim_due_recipients / complete_recipient_send /
// fail_recipient_send); this file only does the sending.
//
// Each email goes out from the customer's OWN mailbox (Google, Microsoft 365 /
// Outlook, or Zoho Mail), so one customer's sending reputation can never
// affect another's. Access tokens are NOT refreshed here: the knoxified-auth
// service owns tokens (its DB-backed refresh lock is what keeps concurrent
// refreshes safe, which matters for Microsoft's rotating refresh tokens), so
// we simply ask it for a valid one.

const BATCH_SIZE = 15;
const DAILY_CAP_PER_USER = 40;
const AUTH_SERVICE_URL_DEFAULT = 'https://oauth.knoxified.org';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

const PROVIDER_LABEL = { google: 'Google', microsoft: 'Microsoft 365 / Outlook', zoho: 'Zoho Mail' };

// The customer's mailbox (or the sign-in service) isn't usable right now.
// This is NOT the email's fault, so it must not burn one of the recipient's 3
// send attempts; it just pushes the recipient back by delayMinutes.
class MailboxUnavailableError extends Error {
  constructor(message, delayMinutes = 360) {
    super(message);
    this.delayMinutes = delayMinutes;
  }
}

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

function bodyWithFooter({ body, senderName, mailingAddress, unsubscribeUrl }) {
  return `${String(body ?? '').replace(/\r\n/g, '\n')}\n${buildFooter({ senderName, mailingAddress, unsubscribeUrl })}`;
}

// Full RFC 2822 message. From is omitted on purpose: the mailbox provider
// fills in the authenticated account itself.
function buildMime({ to, subject, body, senderName, mailingAddress, unsubscribeUrl }) {
  const headers = [
    `To: ${stripLineBreaks(to)}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `List-Unsubscribe: <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];
  const b64 = toBase64Utf8(bodyWithFooter({ body, senderName, mailingAddress, unsubscribeUrl })).replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${b64}`;
}

// Kept for tests and callers that want Gmail's base64url form.
function buildRawMessage(msg) {
  return toBase64Url(buildMime(msg));
}

// ---------- Tokens (from the auth service) ----------

async function getAccessToken(env, userId, provider, fetchImpl) {
  const label = PROVIDER_LABEL[provider] || provider;
  const headers = { 'Content-Type': 'application/json' };
  if (env.INTERNAL_API_KEY) headers['x-internal-key'] = env.INTERNAL_API_KEY;

  let res;
  try {
    res = await fetchImpl(`${env.AUTH_SERVICE_URL || AUTH_SERVICE_URL_DEFAULT}/auth/${provider}/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId }),
    });
  } catch {
    throw new MailboxUnavailableError('Could not reach the sign-in service. Will retry shortly.', 20);
  }
  const data = await res.json().catch(() => ({}));

  if (res.status === 404) {
    throw new MailboxUnavailableError(`${label} is not connected. Connect it in Integrations to resume sending.`);
  }
  if (res.status === 401 && data.error === 'unauthorized') {
    throw new MailboxUnavailableError('The sign-in service rejected this server. Check that INTERNAL_API_KEY matches on both Workers.', 60);
  }
  if (res.status === 401) {
    throw new MailboxUnavailableError(`${label} connection expired. Reconnect it in Integrations to resume sending.`);
  }
  if (!res.ok || !data.accessToken) {
    throw new MailboxUnavailableError(`Couldn't get a ${label} access token (HTTP ${res.status}). Will retry shortly.`, 20);
  }
  return { accessToken: data.accessToken, metadata: data.metadata || null };
}

// ---------- Provider adapters ----------
// Each takes ({ token, metadata, msg, fetchImpl, cache }) and returns the
// provider's message id (or null). 401/403 mean permissions or access were
// revoked: that's the mailbox's problem, not this email's.

async function sendGoogle({ token, msg, fetchImpl }) {
  const res = await fetchImpl(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRawMessage(msg) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new MailboxUnavailableError(`Gmail refused to send (${reason}). Reconnect Google in Integrations and allow sending email.`);
    }
    throw new Error(`Gmail send failed: ${reason}`);
  }
  return json.id || null;
}

// Graph accepts a complete MIME message (base64, Content-Type text/plain).
// MIME is used rather than the JSON form because Graph only lets JSON messages
// carry custom "x-" headers, and List-Unsubscribe must be a real header.
async function sendMicrosoft({ token, msg, fetchImpl }) {
  const res = await fetchImpl(GRAPH_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: toBase64Utf8(buildMime(msg)),
  });
  if (res.ok) return null; // Graph returns 202 with no body and no message id.
  const json = await res.json().catch(() => ({}));
  const reason = json?.error?.message || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) {
    throw new MailboxUnavailableError(`Outlook refused to send (${reason}). Reconnect Microsoft in Integrations and allow sending email.`);
  }
  throw new Error(`Outlook send failed: ${reason}`);
}

// Zoho runs separate data centers; the auth service stores which one the
// customer's account lives in. Only ever build URLs from a real Zoho accounts
// host, since the token is sent to whatever host this resolves to.
const ZOHO_ACCOUNTS_RE = /^accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|com\.cn)|zohocloud\.ca)$/;
function zohoMailBase(metadata) {
  try {
    const host = new URL(metadata?.accounts_server).hostname;
    if (ZOHO_ACCOUNTS_RE.test(host)) return `https://${host.replace(/^accounts\./, 'mail.')}`;
  } catch {
    // fall through to the default data center
  }
  return 'https://mail.zoho.com';
}

function zohoFromAddress(account) {
  const primary = account.primaryEmailAddress;
  if (typeof primary === 'string' && primary) return primary;
  if (Array.isArray(primary) && primary[0]?.mailId) return primary[0].mailId;
  if (account.mailboxAddress) return account.mailboxAddress;
  const list = Array.isArray(account.emailAddress) ? account.emailAddress : [];
  return list.find((e) => e.isPrimary)?.mailId || list[0]?.mailId || null;
}

// Zoho's API has no way to set custom headers, so recipients get the
// unsubscribe link in the footer but no one-click header on this provider.
async function sendZoho({ token, metadata, msg, fetchImpl, cache, userId }) {
  const base = zohoMailBase(metadata);
  const auth = { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };

  let account = cache.zohoAccounts.get(userId);
  if (!account) {
    const res = await fetchImpl(`${base}/api/accounts`, { headers: auth });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new MailboxUnavailableError('Zoho refused access. Reconnect Zoho Mail in Integrations and allow sending email.');
    }
    const first = json?.data?.[0];
    const from = first ? zohoFromAddress(first) : null;
    if (!res.ok || !first?.accountId || !from) {
      throw new Error(`Couldn't read the Zoho mail account (HTTP ${res.status}).`);
    }
    account = { accountId: first.accountId, from };
    cache.zohoAccounts.set(userId, account);
  }

  const res = await fetchImpl(`${base}/api/accounts/${account.accountId}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      fromAddress: account.from,
      toAddress: stripLineBreaks(msg.to),
      subject: stripLineBreaks(msg.subject),
      content: bodyWithFooter(msg),
      mailFormat: 'plaintext',
    }),
  });
  const json = await res.json().catch(() => ({}));
  const code = json?.status?.code;
  if (res.ok && (code === undefined || code === 200)) return json?.data?.messageId ? String(json.data.messageId) : null;

  const reason = json?.data?.moreInfo || json?.status?.description || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) {
    throw new MailboxUnavailableError(`Zoho refused to send (${reason}). Reconnect Zoho Mail in Integrations and allow sending email.`);
  }
  throw new Error(`Zoho send failed: ${reason}`);
}

const ADAPTERS = { google: sendGoogle, microsoft: sendMicrosoft, zoho: sendZoho };

// Mailbox problems push the recipient back WITHOUT using up one of its 3
// attempts, and leave a visible note for the customer.
async function deferRecipient(supabase, recipientId, message, delayMinutes) {
  await supabase
    .from('campaign_recipients')
    .update({
      next_send_at: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
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
  const tokenCache = new Map(); // one token lookup per customer + provider per run
  const cache = { zohoAccounts: new Map() };

  for (const row of due || []) {
    const provider = row.provider || 'google';
    try {
      const adapter = ADAPTERS[provider];
      if (!adapter) throw new Error(`Unsupported mail provider: ${provider}`);

      const cacheKey = `${provider}:${row.user_id}`;
      let tokenPromise = tokenCache.get(cacheKey);
      if (!tokenPromise) {
        tokenPromise = getAccessToken(env, row.user_id, provider, fetchImpl);
        tokenCache.set(cacheKey, tokenPromise);
      }
      const { accessToken, metadata } = await tokenPromise;

      const messageId = await adapter({
        token: accessToken,
        metadata,
        userId: row.user_id,
        cache,
        fetchImpl,
        msg: {
          to: row.to_email,
          subject: row.subject,
          body: row.body,
          senderName: row.sender_name,
          mailingAddress: row.mailing_address,
          unsubscribeUrl: `${env.BASE_URL}/unsubscribe/${row.unsubscribe_token}`,
        },
      });

      const { error: doneErr } = await supabase.rpc('complete_recipient_send', {
        p_recipient_id: row.recipient_id,
        p_email_id: row.email_id,
        p_message_id: messageId,
      });
      if (doneErr) console.error('[Email] complete_recipient_send failed:', doneErr.message);
      stats.sent++;
    } catch (err) {
      if (err instanceof MailboxUnavailableError) {
        await deferRecipient(supabase, row.recipient_id, err.message, err.delayMinutes);
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
  buildMime,
  encodeSubject,
  MailboxUnavailableError,
};
