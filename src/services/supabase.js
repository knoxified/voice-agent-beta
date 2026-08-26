const { createClient } = require('@supabase/supabase-js');

// ─── Supabase Client ───────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // Must be service role key, not anon key
);

// ─── Get user by mapped phone number (PSTN flow) ──────────
async function getUserByPhone(phoneNumber) {
  try {
    const { data, error } = await supabase
      .from('phone_number_mappings')
      .select(`
        user_id,
        users!inner (
          id,
          email,
          plan_id,
          status,
          plans (
            id,
            name,
            limit_voice_minutes
          )
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
      status: data.users.status
    };
  } catch (err) {
    console.error('[Supabase] getUserByPhone error:', err.message);
    return null;
  }
}

// ─── Get user directly by UUID (browser SDK flow) ─────────
async function getUserById(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select(`
        id,
        email,
        plan_id,
        status,
        plans (
          id,
          name,
          limit_voice_minutes
        )
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
      status: data.status
    };
  } catch (err) {
    console.error('[Supabase] getUserById error:', err.message);
    return null;
  }
}

// ─── Get voice settings ────────────────────────────────────
async function getUserVoiceSettings(userId) {
  try {
    const { data, error } = await supabase
      .from('user_voice_settings')
      .select('agent_persona, agent_greeting, quota_exceeded_message, preferred_voice_id')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return {
        agent_persona: 'professional receptionist',
        agent_greeting: 'Hello, thank you for calling. How can I help you?',
        quota_exceeded_message: 'Sorry, your minutes have been exhausted. Please upgrade your plan.',
        preferred_voice_id: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b'
      };
    }

    return data;
  } catch (err) {
    console.error('[Supabase] getUserVoiceSettings error:', err.message);
    return {
      agent_persona: 'professional receptionist',
      agent_greeting: 'Hello, thank you for calling. How can I help you?',
      quota_exceeded_message: 'Sorry, your minutes have been exhausted. Please upgrade your plan.',
      preferred_voice_id: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b'
    };
  }
}

// ─── Check remaining voice quota ───────────────────────────
// Supabase JS client doesn't support SQL aggregates in .select()
// so we fetch rows for the current month and sum in JS
async function checkQuota(userId) {
  try {
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select(`
        plans (
          limit_voice_minutes
        )
      `)
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      console.error('[Supabase] checkQuota user fetch error:', userError?.message);
      // Fail closed in production — don't grant minutes if we can't verify
      return process.env.NODE_ENV === 'development';
    }

    const limitMinutes = userData.plans?.limit_voice_minutes || 0;

    // 0 = unlimited (enterprise/custom plans)
    if (limitMinutes === 0) return true;

    // Get this month's usage rows
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: usageRows, error: usageError } = await supabase
      .from('voice_usage')
      .select('minutes_used')
      .eq('user_id', userId)
      .gte('created_at', startOfMonth.toISOString());

    if (usageError) {
      console.error('[Supabase] checkQuota usage fetch error:', usageError.message);
      // Fail closed — don't grant on DB error in production
      return process.env.NODE_ENV === 'development';
    }

    // Sum in JS — avoids Supabase aggregate limitation
    const usedMinutes = (usageRows || []).reduce(
      (sum, row) => sum + (row.minutes_used || 0), 0
    );
    const remaining = limitMinutes - usedMinutes;

    console.log(`[Quota] User ${userId}: ${usedMinutes}/${limitMinutes} min used, ${remaining} remaining`);

    return remaining > 0;

  } catch (err) {
    console.error('[Supabase] checkQuota exception:', err.message);
    return process.env.NODE_ENV === 'development';
  }
}

// ─── Record voice usage at end of call ────────────────────
// Calls the deduct_voice_minutes() DB function rather than inserting into
// voice_usage directly. That function does two inserts: one into voice_usage
// (what checkQuota/the dashboard read from) and one into the usage table
// with feature_key='voice_minutes' — the second one is what the
// check_credit_warnings trigger listens for. A raw insert here was silently
// skipping that path entirely, so real calls were never triggering credit
// warnings the way automation runs do.
async function deductMinutes(userId, minutesUsed, sessionId) {
  try {
    const { error } = await supabase.rpc('deduct_voice_minutes', {
      p_user_id: userId,
      p_minutes: minutesUsed,
      p_session_id: sessionId || null
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

// ─── Persist the full call transcript at end of call ──────
// messages is the session's running conversation array (system/user/assistant
// turns). Best-effort: a failure here should never break call cleanup.
async function saveCallTranscript(userId, callId, callerNumber, provider, durationSecs, messages) {
  try {
    const { error } = await supabase
      .from('call_transcripts')
      .insert({
        user_id: userId,
        call_id: callId,
        caller_number: callerNumber || null,
        provider: provider || null,
        duration_secs: durationSecs || 0,
        // Drop the leading system prompt — it's not part of the actual conversation.
        messages: (messages || []).filter((m) => m.role !== 'system')
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

module.exports = {
  supabase,
  getUserByPhone,
  getUserById,
  getUserVoiceSettings,
  checkQuota,
  deductMinutes,
  saveCallTranscript
};
