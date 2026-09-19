import { createLiveTranscription, sendAudio as sendToDeepgram, keepAlive } from '../services/stt.js';
import { generateResponse } from '../services/llm.js';
import { synthesizeSpeech } from '../services/tts.js';
import { detectIntent, buildN8nPayload } from '../services/intent.js';
import { triggerAutomation } from '../services/n8n.js';
import {
  getUserById,
  getUserVoiceSettings,
  getAgentConfig,
  getEnabledSystemPrompts,
  getSystemVoiceDefaults,
  getRemainingMinutes,
  deductMinutes,
  saveCallTranscript,
} from '../services/supabase.js';
import { buildGreeting } from '../services/greeting.js';

export class CallSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.callId = null;
    this.userId = null;
    this.callerNumber = null;
    this.provider = null;
    this.isWebCall = false;
    this.isTrial = false;
    this.systemTypeOverride = null;
    this.messages = [];
    this.streamSid = null;

    this.ws = null;
    this.dgWs = null;
    this.keepAliveTimer = null;
    this.isProcessing = false;

    this.callStartedAt = null;
    this.remainingMinutesAtStart = null;
    this.minuteWarningPlayed = false;
    this.quotaExceededMessage = null;
    this.voiceId = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.includes('/test')) {
      const results = {};
      results.deepgramKey = this.env.DEEPGRAM_API_KEY ? 'SET' : 'MISSING';
      results.cartesiaKey = this.env.CARTESIA_API_KEY ? 'SET' : 'MISSING';
      results.supabaseKey = this.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING';
      results.groqKey = this.env.GROQ_API_KEY ? 'SET' : 'MISSING';

      try {
        const deepgramUrl = 'https://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=mulaw&sample_rate=8000&smart_format=true&punctuate=true&interim_results=true&endpointing=300&utterance_end_ms=1000&vad_events=true';
        const res = await fetch(deepgramUrl, {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Token ${this.env.DEEPGRAM_API_KEY}`,
          },
        });
        if (!res.webSocket) {
          results.deepgram = 'FAILED: No WebSocket returned';
        } else {
          const ws = res.webSocket;
          ws.accept();
          results.deepgram = 'WebSocket connected OK';
          ws.close();
        }
      } catch (err) {
        results.deepgram = `ERROR: ${err.message}`;
      }

      try {
        const res = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'X-API-Key': this.env.CARTESIA_API_KEY,
            'Cartesia-Version': '2026-03-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model_id: this.env.CARTESIA_MODEL_ID || 'sonic-3',
            transcript: 'test',
            voice: {
              mode: 'id',
              id: this.env.CARTESIA_VOICE_ID_DEFAULT || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
            },
            output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
            language: 'en',
          }),
        });
        results.cartesia = res.ok ? 'OK (' + (await res.arrayBuffer()).byteLength + ' bytes)' : `FAILED (${res.status})`;
      } catch (err) {
        results.cartesia = `ERROR: ${err.message}`;
      }

      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.includes('/stream')) {
      return this.handleStreamUpgrade(request, url);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleStreamUpgrade(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    this.userId = url.searchParams.get('userId');
    this.callerNumber = url.searchParams.get('callerNumber') || null;
    this.provider = url.searchParams.get('provider') || 'web';
    this.isWebCall = this.provider === 'web';

    console.log(`[Stream] Upgrade request | user: ${this.userId} | provider: ${this.provider}`);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.ws = server;

    server.addEventListener('message', (event) => this.onCallerMessage(event));
    server.addEventListener('close', () => this.onCallerClose());
    server.addEventListener('error', (event) => {
      console.error('[Stream] Caller WS error:', event.message || event);
      this.cleanup();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async onCallerMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { event: evt } = msg;

    if (evt === 'connected') {
      console.log('[Stream] Caller WebSocket connected');
      return;
    }

    if (evt === 'start') {
      try {
        await this.handleStart(msg);
      } catch (err) {
        console.error('[Stream] handleStart threw:', err.message, err.stack);
      }
      return;
    }

    if (evt === 'media') {
      if (msg.media?.track === 'outbound') return;
      if (this.dgWs?.readyState === 1) {
        const bytes = base64ToBytes(msg.media.payload);
        sendToDeepgram(this.dgWs, bytes);
      }
      return;
    }

    if (evt === 'stop') {
      console.log(`[Stream] Stopped | callId: ${this.callId}`);
      await this.endCall();
    }
  }

  async handleStart(msg) {
    this.streamSid = msg.streamSid;
    this.callId =
      msg.start?.customParameters?.CallSid ||
      msg.start?.callSid ||
      msg.start?.call_control_id;

    if (!this.callId && msg.start?.stream_sid) {
      this.streamSid = msg.start.stream_sid;
      this.callId = msg.start.call_control_id;
    }

    // TwiML <Connect><Stream> doesn't reliably pass a query string on the
    // wss:// URL through to this actual WebSocket upgrade request -- the
    // documented, reliable way to get custom data through is nested
    // <Parameter> elements on the <Stream> tag, delivered here as
    // msg.start.customParameters. Prefer those; keep the URL-derived
    // values (set in handleStreamUpgrade) as a fallback for providers
    // that don't go through TwiML (Telnyx's streaming_start command
    // passes stream_url directly, so its query string isn't subject to
    // this limitation).
    if (msg.start?.customParameters?.userId) {
      this.userId = msg.start.customParameters.userId;
    }
    if (msg.start?.customParameters?.callerNumber) {
      this.callerNumber = msg.start.customParameters.callerNumber;
    }
    if (msg.start?.customParameters?.provider) {
      this.provider = msg.start.customParameters.provider;
      this.isWebCall = this.provider === 'web';
    }
    if (msg.start?.customParameters?.systemTypeOverride) {
      this.systemTypeOverride = msg.start.customParameters.systemTypeOverride;
    }

    console.log(`[Stream] Start event | streamSid: ${this.streamSid} | callId: ${this.callId} | userId: ${this.userId}`);

    if (!this.userId || !this.callId) {
      console.error('[Stream] Missing userId or callId, closing');
      this.ws.close();
      return;
    }

    this.callStartedAt = Date.now();

    const user = await getUserById(this.env, this.userId);
    this.isTrial = user?.isTrial || false;
    console.log(`[Stream] User loaded | isTrial: ${this.isTrial}`);

    const [voiceSettings, agentConfig, systemPrompts] = await Promise.all([
      getUserVoiceSettings(this.env, this.userId),
      getAgentConfig(this.env, this.userId),
      getEnabledSystemPrompts(this.env, this.userId, this.systemTypeOverride || null),
    ]);
    this.quotaExceededMessage = voiceSettings.quota_exceeded_message;
    this.voiceId = voiceSettings.preferred_voice_id;
    this.agentConfig = agentConfig || {};
    this.voiceSettingsGreeting = voiceSettings.agent_greeting;

    // System-vertical voice defaults (temperature + tone). Preview mode
    // (systemTypeOverride set, from the per-system preview widget) always
    // uses the previewed vertical's own default -- that's the entire
    // point, hearing how THAT system sounds, regardless of this account's
    // own temperature override. A normal call still respects the
    // account's own explicit override first.
    const effectiveSystemType = this.systemTypeOverride || this.agentConfig.system_type;
    const systemVoiceDefaults = await getSystemVoiceDefaults(this.env, effectiveSystemType);
    this.resolvedTemperature = this.systemTypeOverride
      ? (systemVoiceDefaults?.default_temperature ?? 0.7)
      : (this.agentConfig.temperature != null ? this.agentConfig.temperature
        : systemVoiceDefaults?.default_temperature != null ? systemVoiceDefaults.default_temperature
        : 0.7);
    this.toneDirective = systemVoiceDefaults?.tone_directive || null;

    this.remainingMinutesAtStart = await getRemainingMinutes(this.env, this.userId);

    this.messages = [
      { role: 'system', content: this.buildSystemPrompt(voiceSettings, agentConfig, systemPrompts) },
    ];

    console.log(`[Stream] Started | user: ${this.userId} | provider: ${this.provider} | voice: ${this.voiceId}`);

    try {
      this.dgWs = await createLiveTranscription(
        this.env,
        async (transcript, isSpeechFinal) => {
          if (!isSpeechFinal) return;
          if (this.isProcessing) {
            console.log('[Stream] Still processing previous turn, skipping');
            return;
          }
          this.isProcessing = true;
          await this.processTurn(transcript);
          this.isProcessing = false;
        },
        (err) => console.error('[STT] Connection error:', err.message || err)
      );
      console.log('[Stream] Deepgram WebSocket connected');
    } catch (err) {
      console.error('[Stream] Deepgram connection FAILED:', err.message, err.stack);
    }

    if (this.dgWs) {
      this.keepAliveTimer = keepAlive(this.dgWs);
    } else {
      console.error('[Stream] No Deepgram connection — calls will not be transcribed');
    }

    try {
      // Trial users testing via web call should clearly hear this is a
      // preview, not a real phone call, before anything else -- separate
      // from and ahead of the greeting itself.
      if (this.isWebCall && this.isTrial) {
        const previewNotice = "This is a preview call to test your voice agent. Upgrade your plan to connect a real phone number. Here's what your customers would hear:";
        const previewAudio = await synthesizeSpeech(this.env, previewNotice, this.voiceId);
        this.sendAudioToCaller(previewAudio);
      }

      const recordingEnabled = Boolean(this.agentConfig?.call_recording_enabled);
      // Defaults to required (matches the DB column's own default) --
      // fail-safe toward MORE disclosure, not less, for a real legal
      // requirement. Only skipped if explicitly set to false.
      const aiDisclosureRequired = this.agentConfig?.require_ai_disclosure !== false;
      const greetingText = buildGreeting(this.agentConfig, this.voiceSettingsGreeting, recordingEnabled, aiDisclosureRequired);
      console.log(`[Stream] Synthesizing greeting: "${greetingText}"`);
      const greetingAudio = await synthesizeSpeech(this.env, greetingText, this.voiceId);
      console.log('[Stream] Greeting audio received, sending to caller');
      this.sendAudioToCaller(greetingAudio);
      console.log('[Stream] Greeting sent');
    } catch (err) {
      console.error('[Stream] Greeting error:', err.message, err.stack);
    }
  }

  async processTurn(transcript) {
    const turnStart = Date.now();
    console.log(`[STT] "${transcript}"`);

    try {
      this.messages.push({ role: 'user', content: transcript });

      const intent = detectIntent(transcript);
      let automationResult = null;
      if (intent) {
        console.log(`[Intent] ${intent.type}`);
        const payload = buildN8nPayload(intent, { ...this, callerNumber: this.callerNumber }, transcript);
        automationResult = await triggerAutomation(this.env, intent.type, payload);
      }

      const llmMessages = automationResult
        ? [...this.messages, {
            role: 'system',
            content: `Automation result: ${JSON.stringify(automationResult)}. Use naturally.`,
          }]
        : this.messages;

      const aiText = await generateResponse(this.env, llmMessages, this.resolvedTemperature);
      console.log(`[LLM] "${aiText}"`);

      if (!aiText) return;

      this.messages.push({ role: 'assistant', content: aiText });
      if (this.messages.length > 22) {
        const sys = this.messages[0];
        this.messages = [sys, ...this.messages.slice(-20)];
      }

      const audioResponse = await synthesizeSpeech(this.env, aiText, this.voiceId);
      this.sendAudioToCaller(audioResponse);

      console.log(`[Timing] Turn: ${Date.now() - turnStart}ms`);

      if (this.isWebCall && this.isTrial) {
        await this.checkTrialQuota();
      }
    } catch (err) {
      console.error(`[Turn] Error after ${Date.now() - turnStart}ms:`, err.message, err.stack);
      try {
        const fallback = await synthesizeSpeech(this.env, 'Sorry, could you repeat that?', this.voiceId);
        this.sendAudioToCaller(fallback);
      } catch {
        /* silent */
      }
    }
  }

  async checkTrialQuota() {
    const elapsedMinutes = (Date.now() - this.callStartedAt) / 60000;
    const remaining = this.remainingMinutesAtStart - elapsedMinutes;

    if (remaining <= 0) {
      const closing = this.quotaExceededMessage || 'Your trial minutes are up for now.';
      const audio = await synthesizeSpeech(this.env, closing, this.voiceId);
      this.sendAudioToCaller(audio);
      await this.endCall();
      return;
    }

    if (remaining <= 1 && !this.minuteWarningPlayed) {
      this.minuteWarningPlayed = true;
      const warning = 'Just a heads up, you have about one minute of trial time remaining.';
      const audio = await synthesizeSpeech(this.env, warning, this.voiceId);
      this.sendAudioToCaller(audio);
    }
  }

  sendAudioToCaller(audioBytes) {
    if (!audioBytes || this.ws.readyState !== 1) return;
    if (audioBytes.__telnyxNativeTTS) return;

    const sidKey = (this.provider === 'twilio' || this.provider === 'web') ? 'streamSid' : 'stream_sid';
    this.ws.send(
      JSON.stringify({
        event: 'media',
        [sidKey]: this.streamSid,
        media: { payload: bytesToBase64(audioBytes) },
      })
    );
  }

  buildSystemPrompt(voiceSettings, agentConfig, systemPrompts) {
    const cfg = agentConfig || {};
    const orgName = cfg.organization_name || 'this business';
    const nickname = cfg.agent_nickname ? ` named ${cfg.agent_nickname}` : '';
    const position = cfg.agent_position || voiceSettings.agent_persona || 'receptionist';

    const lines = [
      `You are an AI ${position}${nickname} for ${orgName}.`,
      '',
      'Rules — this is a phone call:',
      '- Maximum 2 sentences per response, no exceptions',
      '- No bullet points, lists, or markdown ever',
      '- Speak naturally and conversationally',
      '- For appointments: collect name, date, time, reason',
      '- If unsure, offer to take a message',
    ];

    if (cfg.business_hours) lines.push(`- Business hours: ${cfg.business_hours}`);
    if (cfg.business_location) lines.push(`- Location: ${cfg.business_location}`);
    if (cfg.main_call_to_action) lines.push(`- Primary goal for callers: ${cfg.main_call_to_action}`);

    // Tone directive is HOW to speak (pace, warmth, formality), kept
    // distinct from systemPrompts below which is WHAT the business does --
    // the two answer different questions and get injected separately
    // rather than folded into one block.
    if (this.toneDirective) {
      lines.push('', `Tone for this call: ${this.toneDirective}`);
    }

    // memory_context is the free-text business summary the client wrote or
    // generated via the "scan my website" feature -- this is the actual
    // fix for "the agent has no memory of the business it's answering for".
    if (cfg.memory_context) {
      lines.push('', 'What you know about this business (use naturally, do not read this list back verbatim):', cfg.memory_context);
    }

    // Industry-specific tone/vocabulary from whichever Systems (verticals)
    // the client has activated -- e.g. plumbing calls talk about triage and
    // dispatch, dental calls stay reassuring and never give clinical advice.
    if (systemPrompts && systemPrompts.length > 0) {
      lines.push('', 'Industry context for this business:');
      for (const p of systemPrompts) lines.push(p);
    }

    if (cfg.negative_instructions) {
      lines.push('', `Things to avoid: ${cfg.negative_instructions}`);
    }

    if (cfg.custom_system_prompt) {
      // Client-authored instructions take precedence and are appended last
      // so they can override the defaults above if they conflict.
      lines.push('', cfg.custom_system_prompt);
    }

    lines.push('', `Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`);

    return lines.join('\n');
  }

  async onCallerClose() {
    console.log(`[Stream] WebSocket closed | callId: ${this.callId}`);
    await this.endCall();
  }

  async endCall() {
    this.cleanup();

    if (!this.callId || !this.callStartedAt) return;

    const durationSecs = Math.round((Date.now() - this.callStartedAt) / 1000);
    const minutesUsed = Math.ceil(durationSecs / 60);

    if (minutesUsed > 0) {
      await deductMinutes(this.env, this.userId, minutesUsed, this.callId);
    }

    if (this.messages.length > 0) {
      await saveCallTranscript(
        this.env,
        this.userId,
        this.callId,
        this.callerNumber,
        this.provider,
        durationSecs,
        this.messages
      );
    }

    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }

    this.callStartedAt = null;
  }

  cleanup() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.dgWs) {
      try {
        this.dgWs.close();
      } catch {
        /* already closed */
      }
      this.dgWs = null;
    }
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
