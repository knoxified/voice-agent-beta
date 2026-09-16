import { createClient } from '@supabase/supabase-js';

function db(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
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
          plans ( id, name, limit_voice_minutes )
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
      isTrial: data.users.plans?.name === 'Trial Package',
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
        plans ( id, name, limit_voice_minutes )
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
      isTrial: data.plans?.name === 'Trial Package',
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
async function getUsedMinutesThisMonth(supabase, userId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('voice_usage')
    .select('minutes_used')
    .eq('user_id', userId)
    .gte('created_at', startOfMonth.toISOString());

  if (error) {
    console.error('[Supabase] getUsedMinutesThisMonth error:', error.message);
    return null;
  }

  return (data || []).reduce((sum, row) => sum + (row.minutes_used || 0), 0);
}

async function checkQuota(env, userId) {
  const supabase = db(env);
  const GENERIC_MESSAGE = 'Sorry, your minutes have been exhausted. Please upgrade your plan.';
  try {
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('credits_locked, plans ( limit_voice_minutes, price )')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      console.error('[Supabase] checkQuota user fetch error:', userError?.message);
      return { ok: false, message: GENERIC_MESSAGE }; // Fail closed
    }

    // Duplicate-account abuse lock: view/navigate the dashboard is still
    // allowed, but nothing that spends minutes or credits. Clears
    // automatically once the account upgrades to a paid plan (see the
    // Flutterwave webhook), so the generic message is still accurate here
    // even on a paid plan in the rare case a paid account gets flagged.
    if (userData.credits_locked) return { ok: false, message: GENERIC_MESSAGE };

    const limitMinutes = userData.plans?.limit_voice_minutes || 0;
    if (limitMinutes === 0) return { ok: true, message: null }; // 0 = unlimited

    const used = await getUsedMinutesThisMonth(supabase, userId);
    if (used === null) return { ok: false, message: GENERIC_MESSAGE }; // Fail closed on DB error

    if (used < limitMinutes) return { ok: true, message: null };

    // Real fix: a Pro/Starter/Enterprise customer hitting their configured
    // minute cap was hearing "please upgrade to a paid plan" -- nonsensical
    // when they're already paying. plans.price > 0 is a reliable paid/trial
    // signal here (real pricing data already in this table), safer than
    // matching an exact plan name string that could drift out of sync.
    const isPaidPlan = (userData.plans?.price || 0) > 0;
    const message = isPaidPlan
      ? "You've used all your voice minutes for this billing cycle. They'll refresh at the start of your next cycle, or you can upgrade to a higher plan for more capacity."
      : GENERIC_MESSAGE;
    return { ok: false, message };
  } catch (err) {
    console.error('[Supabase] checkQuota error:', err.message);
    return { ok: false, message: GENERIC_MESSAGE };
  }
}

/** Remaining minutes this month. Fixed: previously used an invalid SQL
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

    const used = await getUsedMinutesThisMonth(supabase, userId);
    if (used === null) return 0;

    return Math.max(0, limitMinutes - used);
  } catch (err) {
    console.error('[Supabase] getRemainingMinutes error:', err.message);
    return 0;
  }
}

async function deductMinutes(env, userId, minutesUsed, sessionId) {
  const supabase = db(env);
  try {
    const { error } = await supabase.rpc('deduct_voice_minutes', {
      p_user_id: userId,
      p_minutes: minutesUsed,
      p_session_id: sessionId || null,
    });

    if (error) {
      console.error('[Supabase] deductMinutes error:', error.message);
    } else {
      console.log(`[Supabase] Recorded ${minutesUsed} min for user ${userId}`);
    }
  } catch (err) {
    console.error('[Supabase] deductMinutes exception:', err.message);
  }
}

async function saveCallTranscript(env, userId, callId, callerNumber, provider, durationSecs, messages) {
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

// Industry-specific language for whichever systems (verticals) this user
// has activated -- e.g. a plumbing company's agent should talk about
// emergency triage and dispatch, not generic receptionist filler. Each
// system's industry_prompt is authored to match the real language used on
// the marketing site for that vertical (see systems_catalog).
async function getEnabledSystemPrompts(env, userId) {
  const supabase = db(env);
  try {
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
    const { data, error } = await supabase
      .from('agent_configs')
      .select(
        'organization_name, agent_nickname, agent_position, business_hours, business_location, main_call_to_action, custom_system_prompt, memory_context, negative_instructions, call_recording_enabled, temperature, system_type'
      )
      .eq('user_id', userId)
      .maybeSingle();

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
    const { data, error } = await supabase
      .from('systems_catalog')
      .select('default_temperature, tone_directive')
      .eq('id', systemType)
      .maybeSingle();

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
  deductMinutes,
  saveCallTranscript,
  saveCallRecordingUrl,
};
