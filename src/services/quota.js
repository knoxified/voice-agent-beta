const { checkQuota, deductMinutes } = require('./supabase');

// ─── Check quota before call starts ────────────────────────
async function checkQuotaBeforeCall(userId) {
  try {
    return await checkQuota(userId);
  } catch (err) {
    console.error('[Quota] checkQuotaBeforeCall error:', err.message);
    return true; // Fail open
  }
}

// ─── Deduct minutes after call ends ────────────────────────
async function deductMinutesAfterCall(userId, callDurationSeconds) {
  try {
    const minutesUsed = Math.ceil(callDurationSeconds / 60);
    if (minutesUsed > 0) {
      await deductMinutes(userId, minutesUsed);
      console.log(`[Quota] Deducted ${minutesUsed} minutes from user ${userId}`);
    }
    return minutesUsed;
  } catch (err) {
    console.error('[Quota] deductMinutesAfterCall error:', err.message);
    return 0;
  }
}

// ─── Get remaining minutes for user ────────────────────────
async function getRemainingMinutes(userId) {
  try {
    const { data: userData } = await supabase
      .from('users')
      .select('plans(limit_voice_minutes)')
      .eq('id', userId)
      .single();

    const limitMinutes = userData?.plans?.limit_voice_minutes || 0;
    if (limitMinutes === 0) return Number.MAX_SAFE_INTEGER; // Unlimited

    const { data: usageData } = await supabase
      .from('voice_usage')
      .select('SUM(minutes_used) as total')
      .eq('user_id', userId);

    const usedMinutes = usageData?.[0]?.total || 0;
    return Math.max(0, limitMinutes - usedMinutes);
  } catch (err) {
    console.error('[Quota] getRemainingMinutes error:', err.message);
    return 0;
  }
}

module.exports = {
  checkQuotaBeforeCall,
  deductMinutesAfterCall,
  getRemainingMinutes
};