require('dotenv').config();
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// ─── GET /token ───────────────────────────────────────────
// Browser calls this first to get a Twilio access token
// Query param: ?userId=your-uuid
async function browserTokenHandler(req, res) {
  try {
    const userId = req.query.userId || req.body.userId;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Verify user exists in your Supabase
    const { data: user, error } = await supabase
      .from('users')
      .select('id, status')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account not active' });
    }

    // Create access token
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity: userId }
    );

    // Grant voice capability
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: false
    });

    token.addGrant(voiceGrant);

    console.log(`[Token] Issued for user ${userId}`);

    return res.json({
      token: token.toJwt(),
      userId,
      expiresIn: 3600
    });

  } catch (err) {
    console.error('[Token] Error:', err.message);
    return res.status(500).json({ error: 'Token generation failed' });
  }
}

// ─── POST /voice/browser ──────────────────────────────────
// Twilio calls this when browser does device.connect()
// This is your TwiML App's Voice URL
async function browserInboundHandler(req, res) {
  try {
    const { userId, mode, CallSid } = req.body;

    console.log(`[Browser] Call started | User: ${userId} | Mode: ${mode} | SID: ${CallSid}`);

    if (!userId) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Missing user ID. Cannot connect.</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      return res.send(twiml);
    }

    // Load user + voice settings from your Supabase schema
    const { data: voiceSettings } = await supabase
      .from('user_voice_settings')
      .select('agent_persona, agent_greeting, quota_exceeded_message, preferred_voice_id')
      .eq('user_id', userId)
      .single();

    // Load plan limits
    const { data: userData } = await supabase
      .from('users')
      .select('plan_id, plans(limit_voice_minutes, name)')
      .eq('id', userId)
      .single();

    // Check voice minutes remaining
    const { data: usageData } = await supabase
      .from('voice_usage')
      .select('minutes_used')
      .eq('user_id', userId);

    const totalUsed = (usageData || []).reduce((sum, r) => sum + r.minutes_used, 0);
    const minuteLimit = userData?.plans?.limit_voice_minutes || 5;

    if (totalUsed >= minuteLimit) {
      const msg = voiceSettings?.quota_exceeded_message ||
        'Sorry, your voice minutes have been exhausted. Please upgrade your plan.';
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${msg}</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      return res.send(twiml);
    }

    // Store session using your schema field names
    // Import session service
    const { initSession } = require('../services/session');

    await initSession(CallSid, {
      provider: 'twilio',
      userId,                    // your schema uses userId not tenantId
      tenantId: userId,          // keep this for stream.js compatibility
      tenantName: `User ${userId.slice(0, 8)}`,
      agentPersona: voiceSettings?.agent_persona || 'professional receptionist',
      agentGreeting: voiceSettings?.agent_greeting ||
        'Hello, thanks for calling. How can I help you today?',
      preferredVoiceId: voiceSettings?.preferred_voice_id,
      callerNumber: 'browser',
      callStartTime: Date.now(),
      plan: userData?.plans?.name || 'free',
      isBrowserTest: mode === 'browser-test',
      messages: []
    });

    // Return TwiML to start bidirectional media stream
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/voice/stream">
      <Parameter name="CallSid" value="${CallSid}"/>
    </Stream>
  </Connect>
</Response>`;

    res.type('text/xml');
    return res.send(twiml);

  } catch (err) {
    console.error('[Browser] Handler error:', err.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Something went wrong. Please try again.</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }
}

module.exports = { browserTokenHandler, browserInboundHandler };
