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
  try {
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('credits_locked, plans ( limit_voice_minutes )')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      console.error('[Supabase] checkQuota user fetch error:', userError?.message);
      return false; // Fail closed
    }

    // Duplicate-account abuse lock: view/navigate the dashboard is still
    // allowed, but nothing that spends minutes or credits. Clears
    // automatically once the account upgrades to a paid plan (see the
    // Flutterwave webhook).
    if (userData.credits_locked) return false;

    const limitMinutes = userData.plans?.limit_voice_minutes || 0;
    if (limitMinutes === 0) return true; // 0 = unlimited

    const used = await getUsedMinutesThisMonth(supabase, userId);
    if (used === null) return false; // Fail closed on DB error

    return used < limitMinutes;
  } catch (err) {
    console.error('[Supabase] checkQuota error:', err.message);
    return false;
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
    const { error } = await supabase.from('call_transcripts').insert({
      user_id: userId,
      call_id: callId,
      caller_number: callerNumber || null,
      provider: provider || null,
      duration_secs: durationSecs || 0,
      messages: (messages || []).filter((m) => m.role !== 'system'),
    });

    if (error) {
      console.error('[Supabase] saveCallTranscript error:', error.message);
    } else {
      console.log(`[Supabase] Saved transcript for call ${callId}`);
    }
  } catch (err) {
    console.error('[Supabase] saveCallTranscript exception:', err.message);
  }
}

async function getAgentConfig(env, userId) {
  const supabase = db(env);
  try {
    const { data, error } = await supabase
      .from('agent_configs')
      .select(
        'organization_name, agent_nickname, agent_position, business_hours, business_location, main_call_to_action, custom_system_prompt, memory_context, negative_instructions'
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
  logUnmatchedInboundCall,
  checkQuota,
  getRemainingMinutes,
  deductMinutes,
  saveCallTranscript,
};
