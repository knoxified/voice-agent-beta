import { createClient } from '@supabase/supabase-js';

function db(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

// Single source of truth for "is this account on a free trial plan".
// Only an account whose plan row is PRESENT and has no price counts as
// trial. A missing or failed plan lookup is "unknown", never "trial", so a
// lookup problem can never make a paying customer hear upgrade messaging.
// Price-based on purpose (not a plan-name match) -- see getUserByPhone.
function isTrialPlan(plan) {
  const p = Array.isArray(plan) ? plan[0] : plan;
  if (!p) return false;
  return !(Number(p.price) > 0);
}

async function getUserByPhone(env, phoneNumber) {
  const supabase = db(env);
  try {
    const { data, error } = await supabase
      .from('phone_number_mappings')
      .select(`
        user_id,
        users!inner (
          id, email, plan_id, status,
          plans ( id, name, limit_voice_minutes, price )
        )
      `)
      .eq('phone_number', phoneNumber)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      console.warn(`[Supabase] User not found for phone ${phoneNumber}`);
      return null;
    }

    return {
      id: data.user_id,
      email: data.users.email,
      plan: data.users.plans?.name || 'free',
      planId: data.users.plan_id,
      limitVoiceMinutes: data.users.plans?.limit_voice_minutes || 0,
      status: data.users.status,
      // price-based, not a name match -- a test/manually-migrated account
      // can end up with a plan name that no longer matches an exact
      // string like 'Trial Package' even though it's genuinely paid, and
      // this is what was causing the trial preview notice to still play
      // on a Pro account.
      isTrial: isTrialPlan(data.users.plans),
    };
  } catch (err) {
    console.error('[Supabase] getUserByPhone error:', err.message);
    return null;
  }
}

async function getUserById(env, userId) {
  const supabase = db(env);
  try {
    const { data, error } = await supabase
      .from('users')
      .select(`
        id, email, plan_id, status,
        plans ( id, name, limit_voice_minutes, price )
      `)
      .eq('id', userId)
      .single();

    if (error || !data) {
      console.warn(`[Supabase] User not found for ID ${userId}:`, error?.message);
      return null;
    }

    return {
      id: data.id,
      email: data.email,
      plan: data.plans?.name || 'free',
      planId: data.plan_id,
      limitVoiceMinutes: data.plans?.limit_voice_minutes || 0,
      status: data.status,
      // price-based, not a name match -- see getUserByPhone above for why
      isTrial: isTrialPlan(data.plans),
    };
  } catch (err) {
    console.error('[Supabase] getUserById error:', err.message);
    return null;
  }
}

async function getUserVoiceSettings(env, userId) {
  const supabase = db(env);
  const defaults = {
    agent_persona: 'professional receptionist',
    agent_greeting: 'Hello, thank you for calling. How can I help you?',
    quota_exceeded_message: 'Sorry, your minutes have been exhausted. Please upgrade your plan.',
    preferred_voice_id: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
  };
  try {
    const { data, error } = await supabase
      .from('user_voice_settings')
      .select('agent_persona, agent_greeting, quota_exceeded_message, preferred_voice_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return defaults;
    return data;
  } catch (err) {
    console.error('[Supabase] getUserVoiceSettings error:', err.message);
    return defaults;
  }
}

// Supabase's JS client builds PostgREST queries, not raw SQL -- SQL
// aggregate strings like 'SUM(x) as total' inside .select() don't work.
// Fetch the rows and sum in JS instead (same pattern checkQuota already
// used correctly).
// Usage is stored as whole SECONDS (seconds_used) so a 2-second call costs
// 2 seconds, not a full minute. Rows written by the old minutes-only function
// have seconds_used = 0 and minutes_used > 0, so fall back to minutes * 60.
async function getUsedSecondsThisMonth(supabase, userId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('voice_usage')
    .select('minutes_used, seconds_used')
    .eq('user_id', userId)
    .gte('created_at', startOfMonth.toISOString());

  if (error) {
    console.error('[Supabase] getUsedSecondsThisMonth error:', error.message);
    return null;
  }

  return (data || []).reduce(
    (sum, row) => sum + (row.seconds_used > 0 ? row.seconds_used : (row.minutes_used || 0) * 60),
    0
  );
}

async function checkQuota(env, userId) {
  const supabase = db(env);
  const GENERIC_MESSAGE = 'Sorry, your minutes have been exhausted. Please upgrade your plan.';
  // Spoken when OUR lookup fails. Never claim the customer is out of minutes
  // or needs to upgrade because of a database error on our side.
  const TECHNICAL_MESSAGE = "Sorry, we're having a technical problem on our side. Please try again in a moment.";
  try {
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('credits_locked, plans ( limit_voice_minutes, price )')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      console.error('[Supabase] checkQuota user fetch error:', userError?.message);
      return { ok: false, message: TECHNICAL_MESSAGE }; // Fail closed, truthfully
    }

    // Duplicate-account abuse lock: view/navigate the dashboard is still
    // allowed, but nothing that spends minutes or credits. Clears
    // automatically once the account upgrades to a paid plan (see the
    // Flutterwave webhook), so the generic message is still accurate here
    // even on a paid plan in the rare case a paid account gets flagged.
    if (userData.credits_locked) return { ok: false, message: GENERIC_MESSAGE };

    const limitMinutes = userData.plans?.limit_voice_minutes || 0;
    if (limitMinutes === 0) return { ok: true, message: null }; // 0 = unlimited

    const usedSeconds = await getUsedSecondsThisMonth(supabase, userId);
    if (usedSeconds === null) return { ok: false, message: TECHNICAL_MESSAGE }; // Fail closed on DB error, truthfully

    // Exact: the cap is limitMinutes * 60 seconds, not a minute boundary.
    if (usedSeconds < limitMinutes * 60) return { ok: true, message: null };

    // Real fix: a Pro/Starter/Enterprise customer hitting their configured
    // minute cap was hearing "please upgrade to a paid plan" -- nonsensical
    // when they're already paying. plans.price > 0 is a reliable paid/trial
    // signal here (real pricing data already in this table), safer than
    // matching an exact plan name string that could drift out of sync.
    const isPaidPlan = !isTrialPlan(userData.plans) && Number((Array.isArray(userData.plans) ? userData.plans[0] : userData.plans)?.price) > 0;
    const message = isPaidPlan
      ? "You've used all your voice minutes for this billing cycle. They'll refresh at the start of your next cycle, or you can upgrade to a higher plan for more capacity."
      : GENERIC_MESSAGE;
    return { ok: false, message };
  } catch (err) {
    console.error('[Supabase] checkQuota error:', err.message);
    return { ok: false, message: TECHNICAL_MESSAGE };
  }
}

/** Remaining minutes this month (fractional, exact). Fixed: previously used an invalid SQL
 * aggregate string inside .select() that doesn't work with PostgREST. */
async function getRemainingMinutes(env, userId) {
  const supabase = db(env);
  try {
    const { data: userData } = await supabase
      .from('users')
      .select('plans ( limit_voice_minutes )')
      .eq('id', userId)
      .single();

    const limitMinutes = userData?.plans?.limit_voice_minutes || 0;
    if (limitMinutes === 0) return Number.MAX_SAFE_INTEGER; // Unlimited

    const usedSeconds = await getUsedSecondsThisMonth(supabase, userId);
    if (usedSeconds === null) return 0;

    // Returned in minutes (fractional) so CallSession's countdown is exact.
    return Math.max(0, (limitMinutes * 60 - usedSeconds) / 60);
  } catch (err) {
    console.error('[Supabase] getRemainingMinutes error:', err.message);
    return 0;
  }
}

async function deductSeconds(env, userId, seconds, sessionId) {
  const supabase = db(env);
  try {
    const { error } = await supabase.rpc('deduct_voice_seconds', {
      p_user_id: userId,
      p_seconds: seconds,
      p_session_id: sessionId || null,
    });

    if (error) {
      console.error('[Supabase] deductSeconds error:', error.message);
    } else {
      console.log(`[Supabase] Recorded ${seconds}s for user ${userId}`);
    }
  } catch (err) {
    console.error('[Supabase] deductSeconds exception:', err.message);
  }
}

async function saveCallTranscript(env, userId, callId, callerNumber, provider, durationSecs, messages, extra = {}) {
  const supabase = db(env);
  try {
    // Upsert, not insert: the Twilio recording-status webhook may arrive
    // before or after this (recording processing time varies), and both
    // write to the same row keyed by call_id. Neither should clobber the
    // other's columns -- Supabase's upsert only touches the columns it's
    // given, so omitting recording_url here leaves it as-is if the webhook
    // already set it.
    const { error } = await supabase.from('call_transcripts').upsert(
      {
        user_id: userId,
        call_id: callId,
        caller_number: callerNumber || null,
        provider: provider || null,
        duration_secs: durationSecs || 0,
        messages: (messages || []).filter((m) => m.role !== 'system'),
        // Only included when present, so a failed summary never blocks the save.
        ...(extra.summary ? { summary: extra.summary } : {}),
        ...(extra.outcome ? { outcome: extra.outcome } : {}),
      },
      { onConflict: 'call_id' }
    );

    if (error) {
      console.error('[Supabase] saveCallTranscript error:', error.message);
    } else {
      console.log(`[Supabase] Saved transcript for call ${callId}`);
    }
  } catch (err) {
    console.error('[Supabase] saveCallTranscript exception:', err.message);
  }
}

// Stashes the recording URL Twilio's recording-status callback gives us,
// keyed by call_id -- may arrive before or after saveCallTranscript above,
// handled the same upsert-safe way.
async function saveCallRecordingUrl(env, callId, recordingUrl) {
  const supabase = db(env);
  try {
    const { data, error } = await supabase
      .from('call_transcripts')
      .update({ recording_url: recordingUrl })
      .eq('call_id', callId)
      .select('id');
    if (error) {
      console.error('[Supabase] saveCallRecordingUrl error:', error.message);
    } else if (!data || data.length === 0) {
      // Recording finished processing before the transcript row existed --
      // rare (saveCallTranscript fires right at hangup, recording
      // processing takes longer), but if it happens the recording_url is
      // lost for this call rather than risk a NOT NULL violation on a
      // stub insert with no user_id.
      console.warn(`[Supabase] No call_transcripts row yet for call ${callId} -- recording_url not attached`);
    }
  } catch (err) {
    console.error('[Supabase] saveCallRecordingUrl exception:', err.message);
  }
}


// Normalised key so "What are your prices?" and "what's the price" land on one
// open row. Drops filler words, keeps the first few meaningful ones, sorted.
function questionKey(question) {
  const stop = new Set(['the','a','an','is','are','do','does','you','your','what','whats','how','can','could','i','we','my','me','to','of','for','and','or','it','this','that','have','has','there','any','about','please','much','many']);
  const words = String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  return [...new Set(words)].slice(0, 8).sort().join(' ') || String(question || '').toLowerCase().slice(0, 80);
}

// A question the agent could not answer, handed to the owner's "Questions
// waiting" queue. Repeats merge into one row (asked_count goes up).
// Best-effort: a failure must never affect the call.
async function logPendingQuestion(env, userId, question, callId, callerNumber) {
  const q = String(question || '').trim().slice(0, 300);
  if (!userId || q.length < 4) return { ok: false };
  const supabase = db(env);
  try {
    const { data, error } = await supabase.rpc('log_pending_question', {
      p_user_id: userId,
      p_question: q,
      p_question_key: questionKey(q),
      p_call_id: callId || null,
      p_caller_number: callerNumber || null,
    });
    if (error) {
      console.error('[Supabase] logPendingQuestion error:', error.message);
      return { ok: false };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: true, isNew: !!row?.is_new };
  } catch (err) {
    console.error('[Supabase] logPendingQuestion exception:', err.message);
    return { ok: false };
  }
}

// Turns a finished inbound call into a row on the user's Leads page (or bumps
// the existing row for a repeat caller). The record_inbound_lead SQL function
// does the insert-or-bump atomically and is idempotent per call_id, so it is
// safe even though endCall() can be reached from more than one path. Purely
// best-effort: a failure here must never affect the call or its transcript.
async function recordInboundLead(env, userId, callerNumber, callId) {
  if (!userId || !callerNumber || !callId) return;
  // Withheld/anonymous caller IDs arrive as words, not numbers -- not a lead.
  const phone = String(callerNumber).replace(/[\s()-]/g, '');
  if (!/^\+?\d{6,15}$/.test(phone)) return;

  const supabase = db(env);
  try {
    const { error } = await supabase.rpc('record_inbound_lead', {
      p_user_id: userId,
      p_phone: phone,
      p_call_id: callId,
    });
    if (error) {
      console.error('[Supabase] recordInboundLead error:', error.message);
    }
  } catch (err) {
    console.error('[Supabase] recordInboundLead exception:', err.message);
  }
}


function cleanPhone(callerNumber) {
  const phone = String(callerNumber || '').replace(/[\s()-]/g, '');
  return /^\+?\d{6,15}$/.test(phone) ? phone : null;
}

// Name of a caller we have spoken to before (from the lead created at their
// last call), matched by caller ID. Null for new, withheld or web callers.
// Best-effort: never blocks or fails the call.
async function getKnownCaller(env, userId, callerNumber) {
  const phone = cleanPhone(callerNumber);
  if (!userId || !phone) return null;
  try {
    const { data, error } = await db(env)
      .from('leads')
      .select('name, call_count')
      .eq('user_id', userId)
      .eq('phone', phone)
      .maybeSingle();
    if (error || !data) return null;
    const name = String(data.name || '').trim();
    return { name: name || null, callCount: data.call_count || 0 };
  } catch (err) {
    console.error('[Supabase] getKnownCaller exception:', err.message);
    return null;
  }
}

// After a booking, remember the caller's name/email on their lead -- only
// where nothing is stored yet, so a shared phone never overwrites someone else.
async function saveContactToLead(env, userId, callerNumber, { name, email }) {
  const phone = cleanPhone(callerNumber);
  if (!userId || !phone) return;
  try {
    const supabase = db(env);
    if (name) await supabase.from('leads').update({ name }).eq('user_id', userId).eq('phone', phone).is('name', null);
    if (email) await supabase.from('leads').update({ email }).eq('user_id', userId).eq('phone', phone).is('email', null);
  } catch (err) {
    console.error('[Supabase] saveContactToLead exception:', err.message);
  }
}

// Industry-specific language for whichever systems (verticals) this user
// has activated -- e.g. a plumbing company's agent should talk about
// emergency triage and dispatch, not generic receptionist filler. Each
// system's industry_prompt is authored to match the real language used on
// the marketing site for that vertical (see systems_catalog).
// The industry system this account actually runs: its most recently activated
// ENABLED system (user_systems), skipping 'custom' which has no persona of its own.
// Real calls use this when agent_configs.system_type was never set (it defaults
// to 'general', which no catalog row matches). `client` is injectable for tests.
async function getPrimarySystemId(env, userId, client = null) {
  try {
    const supabase = client || db(env);
    const { data, error } = await supabase
      .from('user_systems')
      .select('system_id, activated_at')
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .order('activated_at', { ascending: false, nullsFirst: false });
    if (error || !data?.length) return null;
    const row = data.find((r) => r.system_id && r.system_id !== 'custom');
    return row ? row.system_id : null;
  } catch (err) {
    console.error('[Supabase] getPrimarySystemId error:', err.message);
    return null;
  }
}

async function getEnabledSystemPrompts(env, userId, overrideSystemType = null) {
  const supabase = db(env);
  try {
    // Preview mode (overrideSystemType set): show THAT vertical's own
    // industry context directly, regardless of whether this account has
    // it enabled at all -- they may not, that's the point of previewing it.
    if (overrideSystemType) {
      const { data, error } = await supabase
        .from('systems_catalog')
        .select('industry_prompt')
        .eq('id', overrideSystemType)
        .maybeSingle();
      if (error || !data?.industry_prompt) return [];
      return [data.industry_prompt];
    }

    const { data, error } = await supabase
      .from('user_systems')
      .select('systems_catalog ( name, industry_prompt )')
      .eq('user_id', userId)
      .eq('is_enabled', true);

    if (error || !data) return [];
    return data
      .map((row) => row.systems_catalog?.industry_prompt)
      .filter((p) => typeof p === 'string' && p.trim().length > 0);
  } catch (err) {
    console.error('[Supabase] getEnabledSystemPrompts error:', err.message);
    return [];
  }
}

async function getAgentConfig(env, userId) {
  const supabase = db(env);
  try {
    const BASE_COLS =
      'organization_name, agent_nickname, agent_position, business_hours, business_location, main_call_to_action, custom_system_prompt, memory_context, negative_instructions, call_recording_enabled, temperature, system_type, require_ai_disclosure, custom_intents, business_phone';
    let { data, error } = await supabase
      .from('agent_configs')
      .select(`${BASE_COLS}, website_summary, faqs`)
      .eq('user_id', userId)
      .maybeSingle();

    // Website-knowledge columns not migrated yet: load without them.
    if (error && /website_summary|faqs|does not exist|could not find/i.test(error.message || '')) {
      ({ data, error } = await supabase.from('agent_configs').select(BASE_COLS).eq('user_id', userId).maybeSingle());
    }

    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error('[Supabase] getAgentConfig error:', err.message);
    return null;
  }
}

// Per-vertical voice defaults (temperature + tone directive), keyed by the
// business's own declared system_type. An explicit user override in
// agent_configs.temperature still takes precedence over this -- see
// CallSession.js for the resolution order. Falls back to null (caller
// applies its own global default) if system_type is unset, 'general', or
// doesn't match a real systems_catalog row.
async function getSystemVoiceDefaults(env, systemType) {
  if (!systemType || systemType === 'general') return null;
  const supabase = db(env);
  try {
    let { data, error } = await supabase
      .from('systems_catalog')
      .select('default_temperature, tone_directive, voice_id, playbook, qualification_criteria, speech_speed, speech_emotion')
      .eq('id', systemType)
      .maybeSingle();

    // Persona columns not migrated yet: fall back to the original three.
    if (error && /playbook|qualification_criteria|speech_|does not exist|could not find/i.test(error.message || '')) {
      ({ data, error } = await supabase
        .from('systems_catalog')
        .select('default_temperature, tone_directive, voice_id')
        .eq('id', systemType)
        .maybeSingle());
    }

    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error('[Supabase] getSystemVoiceDefaults error:', err.message);
    return null;
  }
}

// Best-effort diagnostic trail for inbound calls that couldn't be matched
// to a client -- e.g. the shared-number call-forwarding setup, where the
// carrier didn't pass through (or we didn't correctly parse) diversion
// info showing which client's number was actually dialed. Written to the
// existing audit_logs table so the raw payload can be inspected later
// instead of guessing blind at which SIP header a given carrier used.
async function logUnmatchedInboundCall(env, rawPayload, resolvedToNumber) {
  const supabase = db(env);
  try {
    await supabase.from('audit_logs').insert({
      action: 'voice_inbound_unmatched',
      entity_type: 'phone_number',
      metadata: { resolved_to_number: resolvedToNumber || null, raw: rawPayload },
    });
  } catch (err) {
    console.error('[Supabase] logUnmatchedInboundCall error:', err.message);
  }
}

export {
  getUserByPhone,
  getUserById,
  getUserVoiceSettings,
  getAgentConfig,
  getEnabledSystemPrompts,
  getSystemVoiceDefaults,
  logUnmatchedInboundCall,
  checkQuota,
  getRemainingMinutes,
  deductSeconds,
  saveCallTranscript,
  saveCallRecordingUrl,
  recordInboundLead,
  logPendingQuestion,
  getKnownCaller,
  saveContactToLead,
  getPrimarySystemId,
};
