import { createLiveTranscription, sendAudio as sendToDeepgram, keepAlive } from '../services/stt.js';
import { generateWithTools } from '../services/llm.js';
import { synthesizeSpeech, streamSpeech } from '../services/tts.js';
import { TOOL_DEFS, executeTool, businessTimeZone } from '../services/tools.js';
import { sanitizeRules, matchRoutingRule, isValidE164 } from '../services/routing.js';
import { telnyxTransfer } from '../services/telnyx.js';
import {
  getUserById,
  getUserVoiceSettings,
  getAgentConfig,
  getEnabledSystemPrompts,
  getSystemVoiceDefaults,
  getRemainingMinutes,
  deductSeconds,
  saveCallTranscript,
  recordInboundLead,
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
    this.isBrowserCall = false; // browser-direct web call: no Twilio/Telnyx
    this.isTrial = false;
    this.systemTypeOverride = null;
    this.messages = [];
    this.streamSid = null;

    // Owner-defined call routing (agent_configs.custom_intents). Loaded at
    // call start; empty means every turn goes straight to the normal flow.
    this.routingRules = [];
    this.transferNumber = null;
    this.transferInProgress = false;

    this.ws = null;
    this.dgWs = null;
    this.keepAliveTimer = null;
    this.isProcessing = false;

    this.callStartedAt = null;
    this.remainingMinutesAtStart = null;
    this.minuteWarningPlayed = false;
    this.quotaExceededMessage = null;
    this.voiceId = null;

    // Booking / tool state (see services/tools.js)
    this.availabilityChecks = 0;
    this.availabilityNotes = [];
    this.bookingsMade = 0;
    this.bookingConfirmed = null;
    this.callerTurns = 0;

    // Silence handling: ask "still there?" after SILENCE_PROMPT, hang up
    // SILENCE_HANGUP after that if the caller still hasn't spoken.
    this.silenceTimer = null;
    this.silenceStage = 0; // 0 listening, 1 asked "still there?", 2 ending
    this.silenceBusy = false;
    this.lastCallerActivityAt = Date.now();
    this.agentSpeakingUntil = 0;
    this.ending = false;
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
    this.isBrowserCall = this.provider === 'browser';
    if (this.isBrowserCall) {
      // userId was verified from a signed token by the stream route; the call
      // id is the (verified) last path segment, never taken from the client.
      this.callId = url.pathname.split('/').pop();
      this.systemTypeOverride = url.searchParams.get('systemTypeOverride') || null;
    }

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
    this.streamSid = msg.streamSid || (this.isBrowserCall ? 'browser' : undefined);

    // Browser calls may send 16 kHz linear PCM (much better recognition than
    // 8 kHz mu-law). Older clients send no mediaFormat and keep mu-law 8 kHz.
    this.sttFormat = { encoding: 'mulaw', sampleRate: 8000 };
    if (this.isBrowserCall) {
      const mf = msg.start?.mediaFormat;
      if (mf && /l16|linear16/i.test(String(mf.encoding || '')) && Number(mf.sampleRate) === 16000) {
        this.sttFormat = { encoding: 'linear16', sampleRate: 16000 };
      }
    }
    if (!this.isBrowserCall) {
      this.callId =
        msg.start?.customParameters?.CallSid ||
        msg.start?.callSid ||
        msg.start?.call_control_id;
    }

    if (!this.isBrowserCall && !this.callId && msg.start?.stream_sid) {
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
    // Browser-direct calls never take identity or overrides from the client's
    // start frame -- only the values verified from the signed token.
    if (!this.isBrowserCall) {
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

    // Routing rules never apply to the per-system preview widget -- that's
    // for hearing a vertical's default voice, not this account's own setup.
    this.routingRules = this.systemTypeOverride ? [] : sanitizeRules(this.agentConfig.custom_intents, (systemPrompts || []).length > 0);
    this.transferNumber = isValidE164(this.agentConfig.business_phone) ? this.agentConfig.business_phone : null;
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

    // Voice resolution: a previewed system always uses its own vertical voice.
    // On a normal call, an account that explicitly picked a voice keeps it;
    // otherwise (still on the platform default) the account's system voice applies.
    const PLATFORM_DEFAULT_VOICE = this.env.CARTESIA_VOICE_ID_DEFAULT || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b';
    const systemVoice = systemVoiceDefaults?.voice_id || null;
    const accountPickedVoice = voiceSettings.preferred_voice_id && voiceSettings.preferred_voice_id !== PLATFORM_DEFAULT_VOICE && voiceSettings.preferred_voice_id !== 'e07c00bc-4134-4eae-9ea4-1a55fb45746b';
    if (this.systemTypeOverride) this.voiceId = systemVoice || this.voiceId;
    else if (!accountPickedVoice && systemVoice) this.voiceId = systemVoice;

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
        (err) => console.error('[STT] Connection error:', err.message || err),
        () => this.markCallerActivity(),
        { ...this.sttFormat, keyterms: this.buildKeyterms() }
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
      const recordingEnabled = Boolean(this.agentConfig?.call_recording_enabled);
      // Defaults to required (matches the DB column's own default) --
      // fail-safe toward MORE disclosure, not less, for a real legal
      // requirement. Only skipped if explicitly set to false.
      const aiDisclosureRequired = this.agentConfig?.require_ai_disclosure !== false;
      const greetingText = buildGreeting(this.agentConfig, this.voiceSettingsGreeting, recordingEnabled, aiDisclosureRequired);
      console.log(`[Stream] Synthesizing greeting: "${greetingText}"`);
      await this.speak(greetingText);
      console.log('[Stream] Greeting sent');
    } catch (err) {
      console.error('[Stream] Greeting error:', err.message, err.stack);
    }

    this.lastCallerActivityAt = Date.now();
    this.startSilenceMonitor();
  }

  async processTurn(transcript) {
    const turnStart = Date.now();
    console.log(`[STT] "${transcript}"`);

    // A transfer is already handing the caller off; ignore anything still
    // arriving from the STT stream so the agent doesn't talk over it.
    if (this.transferInProgress) return;

    this.markCallerActivity();

    try {
      this.messages.push({ role: 'user', content: transcript });
      this.callerTurns += 1;

      // Owner-defined routing rules are an optional override layer.
      // Returns true when the rule fully handled this turn.
      const rule = matchRoutingRule(this.routingRules, transcript);
      if (rule && (await this.handleRoutingRule(rule))) return;

      // Per-turn context (call-length nudges, availability already looked up)
      // is injected here, never stored in this.messages, so the saved
      // transcript stays clean.
      const working = [...this.messages, ...this.buildDynamicHints()];

      const MAX_TOOL_ROUNDS = 2;
      let aiText = null;
      let usedTool = false;
      const t = { llm: 0, tools: 0, tts: 0, rounds: 0 };

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const llmStart = Date.now();
        const result = await generateWithTools(
          this.env,
          working,
          this.resolvedTemperature,
          round < MAX_TOOL_ROUNDS ? TOOL_DEFS : null
        );
        t.llm += Date.now() - llmStart;
        t.rounds += 1;

        if (result.toolCalls) {
          usedTool = true;
          working.push(result.assistantMessage);

          // Speak a short filler FIRST so there is no dead air while the
          // calendar / booking webhook runs.
          const first = result.toolCalls[0].function?.name;
          const fillStart = Date.now();
          await this.speakFiller(result.content || pickFiller(first));
          t.tts += Date.now() - fillStart;

          for (const call of result.toolCalls) {
            const toolStart = Date.now();
            const out = await executeTool(this, call);
            t.tools += Date.now() - toolStart;
            console.log(`[Tool] ${call.function?.name} ->`, JSON.stringify(out));
            working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) });
          }
          continue;
        }

        aiText = result.content;
        break;
      }

      console.log(`[LLM] "${aiText}"`);
      if (!aiText) {
        if (usedTool) aiText = 'Sorry about that, could you say that once more for me?';
        else return;
      }

      this.pushAssistant(aiText);

      const ttsStart = Date.now();
      await this.speak(aiText);
      t.tts += Date.now() - ttsStart;

      console.log(`[Timing] Turn: ${Date.now() - turnStart}ms | llm ${t.llm}ms (${t.rounds} call${t.rounds === 1 ? '' : 's'}) | tts ${t.tts}ms | tools ${t.tools}ms | promptMsgs ${working.length}`);

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

  // Words Deepgram should be primed to recognise (Nova-3 keyterm prompting).
  buildKeyterms() {
    const cfg = this.agentConfig || {};
    const raw = [cfg.organization_name, cfg.agent_nickname, ...String(cfg.organization_name || '').split(/\s+/)];
    const seen = new Set();
    const out = [];
    for (const t of raw) {
      const term = String(t || '').trim();
      if (term.length < 3 || term.length > 40 || /^(my|business|the|and|inc|llc)$/i.test(term)) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= 10) break;
    }
    return out;
  }

  pushAssistant(text) {
    this.messages.push({ role: 'assistant', content: text });
    if (this.messages.length > 22) {
      const sys = this.messages[0];
      this.messages = [sys, ...this.messages.slice(-20)];
    }
  }

  async speakFiller(text) {
    this.pushAssistant(text);
    await this.speak(text);
  }

  // Speak text to the caller, streaming audio as it is generated.
  async speak(text) {
    await streamSpeech(this.env, text, this.voiceId, (chunk) => this.sendAudioToCaller(chunk));
  }

  // Context the model needs this turn but that doesn't belong in the saved
  // transcript: how long the call has run, and facts learned from tools.
  buildDynamicHints() {
    const hints = [];
    const elapsedSecs = this.callStartedAt ? (Date.now() - this.callStartedAt) / 1000 : 0;
    const softTurns = Number(this.env.CALL_SOFT_TURNS || 5);
    const firmTurns = Number(this.env.CALL_FIRM_TURNS || 9);
    const softSecs = Number(this.env.CALL_SOFT_SECONDS || 150);
    const firmSecs = Number(this.env.CALL_FIRM_SECONDS || 270);

    if (this.bookingConfirmed) {
      const b = this.bookingConfirmed;
      hints.push(`A booking is already confirmed on this call (${b.name}, ${b.date} at ${b.time}). Do not book again. Confirm it warmly in one sentence, ask if there is anything else, and close the call naturally.`);
    } else if (this.callerTurns >= firmTurns || elapsedSecs >= firmSecs) {
      hints.push('The call has gone on long without a clear next step. Wrap up now: offer to take a message, have the team follow up, or send information, then close warmly. Do not start new topics.');
    } else if (this.callerTurns >= softTurns || elapsedSecs >= softSecs) {
      hints.push('You have talked a while. If the caller has a real, specific need you can help with, make your soft next-step suggestion now. If not, start steering toward taking a message or closing politely.');
    }

    if (this.availabilityNotes.length) {
      const lines = this.availabilityNotes.map((n) => `${n.date}: ${n.summary}`).join(' | ');
      hints.push(`Availability already looked up on this call (use it, do not re-check unless the caller changes the day): ${lines}`);
    }

    return hints.map((content) => ({ role: 'system', content }));
  }

  // ---- silence handling ------------------------------------------------------

  markCallerActivity() {
    this.lastCallerActivityAt = Date.now();
    this.silenceStage = 0;
  }

  startSilenceMonitor() {
    if (this.silenceTimer) return;
    this.silenceTimer = setInterval(() => {
      this.checkSilence().catch((err) => console.error('[Silence] check error:', err.message));
    }, 1000);
  }

  async checkSilence() {
    if (!this.callStartedAt || this.ending || this.silenceBusy) return;
    if (this.isProcessing || this.transferInProgress) return;

    const promptMs = Number(this.env.SILENCE_PROMPT_SECONDS || 15) * 1000;
    const hangupMs = Number(this.env.SILENCE_HANGUP_SECONDS || 10) * 1000;

    // Quiet time only counts once the agent has finished speaking.
    const quietSince = Math.max(this.lastCallerActivityAt, this.agentSpeakingUntil);
    const quietFor = Date.now() - quietSince;

    if (this.silenceStage === 0 && quietFor >= promptMs) {
      this.silenceBusy = true;
      this.silenceStage = 1;
      try {
        await this.speakLine(pickRandom(STILL_THERE_LINES));
      } finally {
        this.silenceBusy = false;
      }
      return;
    }

    if (this.silenceStage === 1 && quietFor >= hangupMs) {
      this.silenceBusy = true;
      this.silenceStage = 2;
      this.ending = true;
      try {
        await this.speakLine(pickRandom(SILENCE_GOODBYE_LINES));
        const waitMs = Math.max(0, this.agentSpeakingUntil - Date.now()) + 700;
        await new Promise((r) => setTimeout(r, waitMs));
        await this.endCall();
      } finally {
        this.silenceBusy = false;
      }
    }
  }

  // Speak a fixed line and keep it in the transcript.
  async speakLine(text) {
    this.messages.push({ role: 'assistant', content: text });
    if (this.messages.length > 22) {
      const sys = this.messages[0];
      this.messages = [sys, ...this.messages.slice(-20)];
    }
    await this.speak(text);
  }

  // Returns true if the rule fully handled the turn, false to fall through
  // to the normal intent/LLM flow (e.g. a transfer rule on a call type that
  // can't transfer -- better to answer normally than to go silent).
  async handleRoutingRule(rule) {
    console.log(`[Routing] matched "${rule.label || rule.keywords[0]}" -> ${rule.action}`);

    if (rule.action === 'reply') {
      await this.speakLine(rule.reply);
      return true;
    }

    // action === 'transfer'
    if (this.provider !== 'telnyx') {
      console.warn(`[Routing] transfer not supported on provider "${this.provider}" -- falling through`);
      return false;
    }
    if (!this.transferNumber) {
      console.warn('[Routing] transfer rule matched but no valid business_phone is set -- falling through');
      return false;
    }

    this.transferInProgress = true;
    await this.speakLine("One moment, I'll connect you now.");
    // Let the spoken line finish playing before Telnyx bridges the call.
    await new Promise((r) => setTimeout(r, 2500));

    const result = await telnyxTransfer(this.env, this.callId, this.transferNumber);
    if (!result.ok) {
      this.transferInProgress = false;
      await this.speakLine("I'm sorry, I couldn't connect you just now. Is there anything else I can help with?");
    }
    return true;
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

    const playMs = (audioBytes.length / 8000) * 1000;
    this.agentSpeakingUntil = Math.max(Date.now(), this.agentSpeakingUntil) + playMs;

    const sidKey = (this.provider === 'twilio' || this.provider === 'web' || this.provider === 'browser') ? 'streamSid' : 'stream_sid';
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

    const tz = businessTimeZone(this);
    const lines = [
      `You are an AI ${position}${nickname} for ${orgName}.`,
      '',
      'Rules — this is a phone call:',
      '- Maximum 2 sentences per response, no exceptions. One short sentence is often better.',
      '- No bullet points, lists, or markdown ever',
      '- If unsure, offer to take a message',
      '',
      'Sound like a real person on the phone, not an assistant:',
      '- Use contractions and plain everyday words. Short, natural rhythm. Never sound scripted or corporate.',
      '- React to what they just said before you ask anything, in a way that fits it (for example "oh no, that sounds painful" or "okay, got it" or "hm, that is odd"). Vary your openers; never start two replies the same way.',
      '- Banned phrases: "I\'m here to help", "How may I assist", "Certainly", "Absolutely" (more than rarely), "I understand your concern", "Feel free to", "Is there anything else I can help with" after every answer, "As an AI", and calling yourself a virtual assistant or receptionist after the greeting. Do not stack exclamation marks.',
      '- Match their energy and pace. If they are brief, be brief. If they are chatty or upset, slow down and be warmer.',
      '- Do not repeat their words back, do not summarise, do not list options. Answer what was asked, then stop. Not every reply needs a question.',
      '- Use their name rarely, at most once or twice in a whole call.',
      '- A light human touch is fine, such as "hm", "oh", "well", "right" now and then, but never forced.',
      '- If you do not know something, say so plainly and offer to have someone follow up.',
      '- You are an AI and the greeting already said so. Never pretend to be human, and if someone sincerely asks whether you are a person, tell them the truth in one calm sentence and carry on.',
    ];

    if (cfg.business_hours) lines.push(`- Business hours (they only limit which appointment times you may offer): ${cfg.business_hours}`);
    if (cfg.business_location) lines.push(`- Location: ${cfg.business_location}`);

    // The agent always has a quiet objective, so minutes are never burned on
    // aimless chat, but it must never feel like a sales push.
    lines.push(
      '',
      'How to run the call:',
      '- You are available around the clock to talk. Never tell the caller the business is closed or that you cannot help because of the time of day; only mention hours if they ask, or when choosing appointment times.',
      '- The greeting already asked how you can help, so never ask "how can I help you", "what can I help you with" or "what brings you in today" in any form. If the caller makes small talk, answer it warmly in one sentence and let them bring up their need; only gently invite them if the conversation has gone quiet. Once they state a need, ask specific follow-up questions about that need instead of general ones.',
      '- First understand why they called. Let them talk, react to what they actually say, and ask one natural follow-up question at a time.',
      '- Quietly judge two things as you go: is this a real, specific need we can help with, and are they ready for a next step.',
      '- Never announce, pitch, or mention booking an appointment on your own. Do not ask for a date or time before the caller is qualified.',
      '- Once they are qualified, offer the next step softly in the way a person in your role would (for example suggesting they come in or have the team take a look). Only if they agree do you move to details.',
      '- If they are interested but not ready, offer to take a message or send information. If it is not a fit, or the call is going nowhere, wrap up warmly.',
      '- Booking tools: use check_availability only after they agreed to a next step and you know roughly which day. Use book_appointment only when you have their full name, a valid email, and a specific day and time that they confirmed. Never promise a booking until the tool confirms it.',
      '- Only offer times inside the business hours above. Say things like "give me a moment" naturally while a tool runs.',
    );
    if (cfg.main_call_to_action) {
      lines.push(`- The outcome that makes a call successful for this business: ${cfg.main_call_to_action}. Work toward it only through the steps above, never by pushing.`);
    }

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

    lines.push('', `Today: ${new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Dates you pass to tools use the business timezone (${tz}).`);

    return lines.join('\n');
  }

  async onCallerClose() {
    console.log(`[Stream] WebSocket closed | callId: ${this.callId}`);
    await this.endCall();
  }

  async endCall() {
    this.ending = true;
    this.cleanup();

    if (!this.callId || !this.callStartedAt) return;

    // Exact seconds, no per-call rounding up to a whole minute.
    const durationSecs = Math.round((Date.now() - this.callStartedAt) / 1000);

    if (durationSecs > 0) {
      await deductSeconds(this.env, this.userId, durationSecs, this.callId);
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

      // Only calls where the caller actually said something become leads --
      // a hang-up during the greeting or a silent line is not a lead.
      const callerSpoke = this.messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0
      );
      if (callerSpoke) {
        await recordInboundLead(this.env, this.userId, this.callerNumber, this.callId);
      }
    }

    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }

    this.callStartedAt = null;
  }

  cleanup() {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
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

const STILL_THERE_LINES = [
  'Hello? Are you still there?',
  'Are you still with me?',
  'Hi, are you still there?',
];

const SILENCE_GOODBYE_LINES = [
  "I'm not hearing anything, so I'll let you go. Feel free to call back anytime. Goodbye!",
  "It seems we got disconnected, so I'll end the call for now. Call back whenever you like. Goodbye!",
];

const FILLERS = {
  check_availability: ['Let me check that for you.', 'One moment while I look at the calendar.', 'Give me just a second to check.'],
  book_appointment: ['Give me a moment while I get that set up.', 'One moment, I am booking that for you now.', 'Bear with me a second while I lock that in.'],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickFiller(toolName) {
  return pickRandom(FILLERS[toolName] || ['One moment.']);
}
