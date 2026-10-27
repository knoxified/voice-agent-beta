import { createLiveTranscription, sendAudio as sendToDeepgram, keepAlive } from '../services/stt.js';
import { generateWithTools, streamWithTools } from '../services/llm.js';
import { synthesizeSpeech, streamSpeech, EMOTIONS } from '../services/tts.js';
import { TOOL_DEFS, QUESTION_TOOL, MESSAGE_TOOL, executeTool, businessTimeZone } from '../services/tools.js';
import { decideOutcome, buildCallSummary } from '../services/callSummary.js';
import { classifyStage } from '../services/qualifier.js';
import { parseDayMention, parseTimeMention, matchSlot, dayLabel } from '../services/scheduling.js';
import { sanitizeRules, matchRoutingRule, isValidE164 } from '../services/routing.js';
import { telnyxTransfer, telnyxHangup } from '../services/telnyx.js';
import { getKnownCaller, saveContactToLead, saveLeadCallDetails,
  getUserById,
  getUserVoiceSettings,
  getAgentConfig,
  getEnabledSystemPrompts,
  getSystemVoiceDefaults,
  getPrimarySystemId,
  recordCallLead,
  saveLeadDetailsById,
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
    this.isDemo = false;
    this.demoStartedAt = null;

    this.callStartedAt = null;
    this.remainingMinutesAtStart = null;
    this.minuteWarningPlayed = false;
    this.quotaExceededMessage = null;
    this.voiceId = null;

    // Booking / tool state (see services/tools.js)
    this.availabilityChecks = 0;
    this.availabilityNotes = [];
    this.availabilitySlots = new Map(); // date -> Set of open slot start times (ms)
    this.availabilityCache = new Map(); // date -> tool result (never pay twice for a day)

    // Conversation stage (see services/qualifier.js). Tools stay hidden until
    // the caller has agreed to a next step.
    this.stage = 'discover';
    this.actionUnlocked = false;
    this.queuedTranscript = '';

    // Scheduling state, driven by the code (services/scheduling.js), not the model.
    this.activeDate = null; // day the caller is talking about (YYYY-MM-DD)
    this.selectedSlot = null; // { date, time: 'HH:MM', label } once the caller picks an open time
    this.timeNotOpen = null; // label of a time they asked for that is not open (one turn)

    // Barge-in
    this.speakEpoch = 0;
    this.speechStartedAt = 0;
    this.lastInterruptAt = 0;
    this.bookingsMade = 0;
    this.bookingConfirmed = null;
    this.knownCaller = null;
    this.capturedContact = null;
    this.questionsLogged = 0;
    this.followUp = null; // set by take_message: { message, phone, email, name }
    this.effectiveSystemType = null;
    this.callerTurns = 0;
    // Caller-name capture: ask early and naturally (see nameHint()).
    this.callerName = null;
    this.nameDeclined = false;
    this.nameAsks = 0;        // times the agent actually asked
    this.nameAskedTurn = 0;   // callerTurns value when it last asked
    this.nameHintCache = null;

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
      // index.js strips client-supplied params and re-adds isDemo only when the
      // signed token says so, so this value is server-verified.
      this.isDemo = url.searchParams.get('isDemo') === '1';
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

    // Demo flag was set in handleStreamUpgrade from the verified token
    // (forwarded by index.js) — never from raw browser query params.
    if (this.isDemo) this.demoStartedAt = Date.now();

    const user = await getUserById(this.env, this.userId);
    this.isTrial = this.isDemo ? false : (user?.isTrial || false);
    console.log(`[Stream] User loaded | isTrial: ${this.isTrial}${this.isDemo ? ' | DEMO' : ''}`);

    let voiceSettings, agentConfig, systemPrompts;

    if (this.isDemo) {
      // Demo: load industry defaults only — skip user config, FAQs, website summary.
      const [vs, systemVoiceDefaults] = await Promise.all([
        getUserVoiceSettings(this.env, this.userId),
        getSystemVoiceDefaults(this.env, this.systemTypeOverride),
      ]);
      voiceSettings = vs;
      systemPrompts = null;
      const industryName = systemVoiceDefaults?.name || this.systemTypeOverride || 'Business';
      agentConfig = {
        organization_name: `Knoxified ${industryName}`,
        agent_nickname: 'Alex',
        system_type: this.systemTypeOverride,
        main_call_to_action: 'schedule a visit or appointment',
        require_ai_disclosure: true,
        call_recording_enabled: false,
      };
      this.routingRules = [];
      this.transferNumber = null;
      this.effectiveSystemType = this.systemTypeOverride;
      this.resolvedTemperature = systemVoiceDefaults?.default_temperature ?? 0.7;
      this.toneDirective = systemVoiceDefaults?.tone_directive || null;
      this.playbook = systemVoiceDefaults?.playbook || null;
      this.qualificationCriteria = systemVoiceDefaults?.qualification_criteria || null;
      this.speechSpeed = Number(systemVoiceDefaults?.speech_speed) || null;
      this.speechEmotion = systemVoiceDefaults?.speech_emotion || null;
      const PLATFORM_DEFAULT = this.env.CARTESIA_VOICE_ID_DEFAULT || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b';
      this.voiceId = systemVoiceDefaults?.voice_id || vs.preferred_voice_id || PLATFORM_DEFAULT;
      this.remainingMinutesAtStart = 999;
      this.knownCaller = null;
      console.log(`[Demo] industry: ${this.systemTypeOverride} | company: ${agentConfig.organization_name} | voice: ${this.voiceId}`);
    } else {
      [voiceSettings, agentConfig, systemPrompts] = await Promise.all([
        getUserVoiceSettings(this.env, this.userId),
        getAgentConfig(this.env, this.userId),
        getEnabledSystemPrompts(this.env, this.userId, this.systemTypeOverride || null),
      ]);
      this.knownCaller = this.isWebCall ? null : await getKnownCaller(this.env, this.userId, this.callerNumber);
    }

    this.quotaExceededMessage = voiceSettings.quota_exceeded_message;
    this.voiceId = this.voiceId || voiceSettings.preferred_voice_id;
    this.agentConfig = agentConfig || {};

    if (!this.isDemo) {
      this.routingRules = this.systemTypeOverride ? [] : sanitizeRules(this.agentConfig.custom_intents, (systemPrompts || []).length > 0);
      this.transferNumber = isValidE164(this.agentConfig.business_phone) ? this.agentConfig.business_phone : null;
    }
    this.voiceSettingsGreeting = voiceSettings.agent_greeting;

    if (!this.isDemo) {
      // System-vertical voice defaults (temperature + tone). Preview mode
      // (systemTypeOverride set, from the per-system preview widget) always
      // uses the previewed vertical's own default -- that's the entire
      // point, hearing how THAT system sounds, regardless of this account's
      // own temperature override. A normal call still respects the
      // account's own explicit override first.
      const configuredType = this.agentConfig.system_type && this.agentConfig.system_type !== 'general' ? this.agentConfig.system_type : null;
      const effectiveSystemType = this.systemTypeOverride || configuredType || (await getPrimarySystemId(this.env, this.userId));
      this.effectiveSystemType = effectiveSystemType || null;
      console.log(`[Persona] system: ${effectiveSystemType || 'none'}${this.systemTypeOverride ? ' (preview)' : ''}`);
      const systemVoiceDefaults = effectiveSystemType ? await getSystemVoiceDefaults(this.env, effectiveSystemType) : null;
      this.resolvedTemperature = systemVoiceDefaults?.default_temperature != null
        ? systemVoiceDefaults.default_temperature
        : (!this.systemTypeOverride && this.agentConfig.temperature != null ? this.agentConfig.temperature : 0.7);
      this.toneDirective = systemVoiceDefaults?.tone_directive || null;
      this.playbook = systemVoiceDefaults?.playbook || null;
      this.qualificationCriteria = systemVoiceDefaults?.qualification_criteria || null;
      this.speechSpeed = Number(systemVoiceDefaults?.speech_speed) || null;
      this.speechEmotion = systemVoiceDefaults?.speech_emotion || null;

      const PLATFORM_DEFAULT_VOICE = this.env.CARTESIA_VOICE_ID_DEFAULT || 'e07c00bc-4134-4eae-9ea4-1a55fb45746b';
      const systemVoice = systemVoiceDefaults?.voice_id || null;
      const accountPickedVoice = voiceSettings.preferred_voice_id && voiceSettings.preferred_voice_id !== PLATFORM_DEFAULT_VOICE && voiceSettings.preferred_voice_id !== 'e07c00bc-4134-4eae-9ea4-1a55fb45746b';
      if (this.systemTypeOverride) this.voiceId = systemVoice || this.voiceId;
      else if (!accountPickedVoice && systemVoice) this.voiceId = systemVoice;

      this.remainingMinutesAtStart = await getRemainingMinutes(this.env, this.userId);
    }

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
            // Don't drop what the caller said while we were busy; handle it next.
            this.queuedTranscript = `${this.queuedTranscript} ${transcript}`.trim();
            console.log('[Stream] Caller spoke while busy, queued');
            return;
          }
          this.isProcessing = true;
          try {
            // Push the user's words to the browser transcript panel immediately.
            if (this.ws?.readyState === 1) {
              this.ws.send(JSON.stringify({ event: 'transcript', role: 'user', text: transcript }));
            }

            let next = transcript;
            while (next && !this.ending) {
              this.queuedTranscript = '';
              await this.processTurn(next);
              // Coalesce: give rapid follow-on fragments ("Hello?" "Can you hear me?")
              // a 250 ms window to arrive before we fire another LLM turn.
              if (this.queuedTranscript) await new Promise((r) => setTimeout(r, 250));
              next = this.queuedTranscript;
            }
          } finally {
            this.isProcessing = false;
          }
        },
        (err) => console.error('[STT] Connection error:', err.message || err),
        (text) => this.markCallerActivity(text),
        { ...this.sttFormat, keyterms: this.buildKeyterms(), utteranceEndMs: Math.max(1000, Number(this.env.STT_UTTERANCE_END_MS || 1000)) }
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
    // Demo hard cut: 100 s max — speak a one-line goodbye and hang up.
    if (this.isDemo && this.demoStartedAt && Date.now() - this.demoStartedAt > 100_000) {
      console.log('[Demo] 100 s hard cut');
      await this.speak('Thanks for trying Knoxified! Get your own agent at knoxified dot org. Goodbye!');
      await this.hangUpAfterPlayback();
      return;
    }
    const turnStart = Date.now();
    console.log(`[STT] "${transcript}"`);

    // A transfer is already handing the caller off; ignore anything still
    // arriving from the STT stream so the agent doesn't talk over it.
    if (this.transferInProgress) return;

    this.markCallerActivity();

    try {
      this.messages.push({ role: 'user', content: transcript });
      this.callerTurns += 1;
      this.noteCallerName(transcript);

      // Judge the conversation stage in parallel with the reply (no added latency).
      const stagePromise = this.updateStage();

      // Owner-defined routing rules are an optional override layer.
      // Returns true when the rule fully handled this turn.
      const rule = matchRoutingRule(this.routingRules, transcript);
      if (rule && (await this.handleRoutingRule(rule))) return;

      // Per-turn context (call-length nudges, availability already looked up)
      // is injected here, never stored in this.messages, so the saved
      // transcript stays clean.
      // The caller naming a day while the judge still says "qualified" means they
      // agreed: settle the stage first so the calendar is checked this very turn.
      if (!this.actionUnlocked && !this.bookingConfirmed && (this.stage === 'qualified' || this.stage === 'discover')
          && parseDayMention(transcript, businessTimeZone(this))) {
        await stagePromise;
      }
      if (this.actionUnlocked && !this.bookingConfirmed) await this.prepareScheduling(transcript);

      const working = [...this.messages, ...this.buildDynamicHints()];

      const MAX_TOOL_ROUNDS = 2;
      let aiText = null;
      let usedTool = false;
      let streamedFinal = false;
      let finalSpeaker = null;

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const toolList = round < MAX_TOOL_ROUNDS ? (this.actionUnlocked ? [...TOOL_DEFS, QUESTION_TOOL, MESSAGE_TOOL] : [QUESTION_TOOL, MESSAGE_TOOL]) : null;

        // Speak each sentence as the model writes it, so the first words reach
        // the caller while the rest is still being generated. If streaming
        // fails before anything was said, fall back to the one-shot call.
        const speaker = this.makeStreamSpeaker();
        let result;
        try {
          result = await streamWithTools(this.env, working, this.resolvedTemperature, toolList, speaker.onSentence);
        } catch (err) {
          if (speaker.count() > 0) throw err;
          console.warn('[LLM] stream failed, using one-shot:', err.message);
          if (/timed? ?out|timeout/i.test(String(err.message))) await this.speakFiller('Sorry, give me one second.');
          result = await generateWithTools(this.env, working, this.resolvedTemperature, toolList);
        }
        await speaker.drain();
        if (!result.toolCalls) { streamedFinal = result.streamed; finalSpeaker = speaker; }

        if (result.toolCalls) {
          usedTool = true;
          working.push(result.assistantMessage);

          // Speak a short filler FIRST so there is no dead air while the
          // calendar / booking webhook runs.
          const first = result.toolCalls[0].function?.name;
          if (result.streamedLeadIn) {
            this.pushAssistant(speaker.text()); // already spoken while streaming
          } else {
            await this.speakFiller(result.content || pickFiller(first));
          }

          // Run all tool calls in parallel — most turns only have one, but
          // parallel execution eliminates any wait when the model stacks two.
          const toolResults = await Promise.all(
            result.toolCalls.map((call) =>
              executeTool(this, call).then((out) => {
                console.log(`[Tool] ${call.function?.name} ->`, JSON.stringify(out));
                return { call, out };
              })
            )
          );
          for (const { call, out } of toolResults) {
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

      // End-of-call: the model appends [END] to its final goodbye; as a safety
      // net also end when the caller closed AND the agent said a farewell.
      aiText = dedupeRepeat(aiText);
      let mood = null;
      const moodMatch = aiText.match(/\[mood:\s*([a-z]+)\s*\]/i);
      if (moodMatch && EMOTIONS.has(moodMatch[1].toLowerCase())) mood = moodMatch[1].toLowerCase();
      aiText = aiText.replace(/\[mood:[^\]]*\]\s*/gi, '').trim();
      let endAfter = /\[END\]/i.test(aiText);
      aiText = aiText.replace(/\s*\[END\]\s*/gi, ' ').trim();
      if (!endAfter && FAREWELL_RE.test(aiText) && CALLER_CLOSING_RE.test(transcript)) endAfter = true;
      if (!aiText) aiText = 'Take care.';
      // Don't end the call while a booking the caller agreed to is still unfinished,
      // unless the caller themselves is clearly saying goodbye.
      if (endAfter && this.actionUnlocked && !this.bookingConfirmed && !CALLER_CLOSING_RE.test(transcript)) {
        console.log('[Call] Not ending: booking still in progress');
        endAfter = false;
      }

      this.pushAssistant(aiText);

      // Push the agent's reply text to the browser transcript panel.
      if (this.ws?.readyState === 1) {
        this.ws.send(JSON.stringify({ event: 'transcript', role: 'agent', text: aiText }));
      }

      const spokeAt = streamedFinal ? turnStart : Date.now();
      if (!streamedFinal) await this.speak(aiText, { mood });
      else if (finalSpeaker) mood = finalSpeaker.mood() || mood;
      if (endAfter && this.lastInterruptAt >= spokeAt) endAfter = false; // they talked over the goodbye

      if (endAfter) {
        console.log('[Call] Ending call after goodbye');
        await this.hangUpAfterPlayback();
        return;
      }


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

  // Runs BEFORE the reply when the caller has agreed to a next step. The code,
  // not the model, resolves the day, checks the calendar once per day, and
  // locks in the time the caller picks.
  async prepareScheduling(transcript) {
    const tz = businessTimeZone(this);
    this.timeNotOpen = null;

    const day = parseDayMention(transcript, tz);
    if (day && (day !== this.activeDate || !this.availabilityCache.has(day))) {
      this.activeDate = day;
      if (day !== this.selectedSlot?.date) this.selectedSlot = null;
      if (!this.availabilityCache.has(day)) {
        await this.speakFiller(pickFiller('check_availability'));
        const out = await executeTool(this, { id: 'auto', function: { name: 'check_availability', arguments: JSON.stringify({ date: day }) } });
        console.log(`[Calendar] ${day} ->`, JSON.stringify(out).slice(0, 240));
      }
    }

    if (this.activeDate && this.availabilitySlots.has(this.activeDate)) {
      const parsed = parseTimeMention(transcript);
      if (parsed) {
        const m = matchSlot(this.availabilitySlots.get(this.activeDate), parsed, tz);
        if (m?.time) {
          this.selectedSlot = { date: this.activeDate, time: m.time, label: m.label };
          console.log(`[Calendar] locked ${this.activeDate} ${m.time}`);
        } else if (m?.notOpen) {
          this.timeNotOpen = m.label;
          console.log(`[Calendar] ${m.label} is not open on ${this.activeDate}`);
        }
      }
    }
  }

  agreedHint() {
    const tz = businessTimeZone(this);
    const L = ['Stage: the caller agreed to a next step. The calendar is handled for you automatically; never claim to check it yourself.'];
    if (!this.activeDate) {
      L.push('1) Ask which day suits them. You have NO calendar information yet, so do not mention any times or openings.');
      return L.join('\n');
    }
    const dl = dayLabel(this.activeDate, tz);
    const info = this.availabilityCache.get(this.activeDate);
    if (!info) {
      L.push(`The calendar for ${dl} could not be checked right now. Do not offer any times. Offer to take their details so the team can follow up.`);
      return L.join('\n');
    }
    if (!info.hasOpenings) {
      L.push(`There are no openings on ${dl}. Say so briefly and ask for another day.`);
      return L.join('\n');
    }
    if (!this.selectedSlot) {
      L.push(`2) The calendar for ${dl} is ALREADY checked. Open start times: ${info.openRanges.join('; ')}. Offer two or three that fit what they asked for, naturally (for example "I have 10 or 2:30"). Never name a time outside these ranges.`);
      if (this.timeNotOpen) L.push(`They asked for ${this.timeNotOpen}, which is NOT open. Say so briefly and offer the nearest open times.`);
      L.push('Do not ask for their name or email yet.');
      return L.join('\n');
    }
    L.push(`2) LOCKED IN: ${this.selectedSlot.label} on ${dl}. This time is open and final. Do not offer, mention or discuss any other time, and never check the calendar again unless THEY ask for a different day.`);
    if (this.callerName) {
      L.push(`3) Name: they already told you their name (${this.callerName}). Do not ask for it again. If you only have a first name, ask once for their last name ("and your last name?"); otherwise just confirm you will book it under ${this.callerName}.`);
    } else L.push('3) Name: ask for their full name. When they say it, repeat it back ONCE in a natural way ("Sarah Okafor, is that right?"). Spell it letter by letter only if they correct you or it is an unusual name you are unsure of.');
    L.push('4) Email: ask for their best email and tell them to take it slowly. Read it back in short pieces with a natural pause: the part before the at sign first, then "at", then the domain. Say common domains as one word ("gmail dot com", "yahoo dot com", "outlook dot com"), never spelled out. Spell letter by letter only the part before the at sign, and only if it is not a plain word. Then ask "did I get that right?" If something is wrong, fix just that piece and read only that piece back again. Do not move on until they say yes. Never ask for a phone number; accept it only if they offer.');
    L.push('5) Only after they confirm both the name and the email, use book_appointment with a one-sentence reason for the visit taken from what they told you, and details_confirmed true. Say "one moment" naturally first. Never say it is booked until the tool confirms.');
    return L.join('\n');
  }

  updateStage() {
    const cfg = this.agentConfig || {};
    return classifyStage(this.env, this.messages, { businessName: cfg.organization_name, criteria: this.qualificationCriteria })
      .then((r) => {
        if (!r) return;
        let stage = r.stage;
        // Once the caller agreed, later short answers (names, emails) must not re-lock the tools.
        if (this.actionUnlocked && (stage === 'discover' || stage === 'qualified')) stage = 'agreed';
        if (stage !== this.stage) console.log(`[Stage] ${this.stage} -> ${stage} (${r.reason})`);
        this.stage = stage;
        if (stage === 'agreed') this.actionUnlocked = true;
        else if (stage === 'declined' || stage === 'not_fit') this.actionUnlocked = false;
      })
      .catch(() => {});
  }

  pushAssistant(text) {
    this.messages.push({ role: 'assistant', content: text });
    if (!this.callerName && /\b(your name|who am i (speaking|talking) (with|to)|who do i have|who(?:'s| is) (this|calling)|what should i call you|who(?:'s| is) on the line|may i ask who)\b/i.test(String(text))) {
      this.nameAsks += 1;
      this.nameAskedTurn = this.callerTurns;
    }
    if (this.messages.length > 22) {
      const sys = this.messages[0];
      this.messages = [sys, ...this.messages.slice(-20)];
    }
  }

  // Turns streamed sentences into audio in order. Each sentence is spoken as
  // soon as the previous one has been handed to the line. If the caller
  // interrupts, the rest of the reply is dropped.
  makeStreamSpeaker() {
    const interruptMark = this.lastInterruptAt;
    let chain = Promise.resolve();
    const spoken = [];
    let mood = null;
    const onSentence = (raw) => {
      let t = String(raw || '');
      const mm = t.match(/\[mood:\s*([a-z]+)\s*\]/i);
      if (mm && !mood && EMOTIONS.has(mm[1].toLowerCase())) mood = mm[1].toLowerCase();
      t = t.replace(/\[mood:[^\]]*\]\s*/gi, '').replace(/\s*\[END\]\s*/gi, ' ').trim();
      if (!t || spoken[spoken.length - 1] === t) return;
      spoken.push(t);
      chain = chain
        .then(() => {
          if (this.lastInterruptAt !== interruptMark || this.transferInProgress) return null;
          return this.speak(t, { mood });
        })
        .catch((e) => console.error('[Speak] sentence failed:', e.message));
    };
    return { onSentence, drain: () => chain, text: () => spoken.join(' '), count: () => spoken.length, mood: () => mood };
  }

  async speakFiller(text) {
    this.pushAssistant(text);
    await this.speak(text);
  }

  // Let the last spoken line finish playing, then really hang up.
  async hangUpAfterPlayback() {
    this.ending = true;
    const waitMs = Math.max(0, this.agentSpeakingUntil - Date.now()) + 800;
    await new Promise((r) => setTimeout(r, waitMs));
    if (this.provider === 'telnyx' && this.callId) {
      await telnyxHangup(this.env, this.callId);
    }
    await this.endCall();
  }

  // Speak text to the caller, streaming audio as it is generated.
  async speak(text, opts = {}) {
    const epoch = ++this.speakEpoch;
    this.speechStartedAt = Date.now();
    await streamSpeech(
      this.env,
      text,
      this.voiceId,
      (chunk) => { if (epoch === this.speakEpoch) this.sendAudioToCaller(chunk); },
      () => epoch !== this.speakEpoch,
      { speed: this.speechSpeed, emotion: opts.mood || this.speechEmotion }
    );
  }

  // Picks up the caller's name from what they said, so we never ask twice.
  // Deliberately conservative: the model still sees the whole conversation
  // and is told not to ask if the name was already given.
  noteCallerName(transcript) {
    if (this.callerName) return;
    const text = String(transcript || '').trim();
    const NOT_NAMES = /^(calling|looking|trying|interested|just|here|not|sorry|good|fine|great|well|wondering|hoping|having|in|a|an|the|from|at|with|new|sure|yes|yeah|okay|ok|hi|hello|hey|thanks|thank|um|uh|so|really|actually|also|about|going|getting|needing|wanting|worried|calling|ready|back|late|on|for|to|and|but|it|that|this|how|what|when|where|why|who|please|real|dental|glad|happy|afraid|concerned|curious|thinking)$/i;
    const cap = (w) => /^[A-Z][a-z'’-]{1,18}$/.test(w) && !NOT_NAMES.test(w);

    // 1) Explicit introduction: "my name is Sarah Okafor", "this is Sarah", "I'm Sarah".
    const m = text.match(/\b(?:my name(?:'s|’s| is)|name(?:'s|’s)|this is|call me|it(?:'s|’s) |i(?:'m|’m| am))\s*([A-Za-z'’-]+)(?:\s+([A-Za-z'’-]+))?/i);
    if (m && cap(m[1])) {
      this.callerName = cap(m[2] || '') ? `${m[1]} ${m[2]}` : m[1];
      console.log('[Name] Caller introduced themselves');
      return;
    }

    // 2) A short answer right after the agent asked: "Sarah", "It's Sarah Okafor", "Sarah O.".
    if (this.nameAsks > 0 && this.callerTurns === this.nameAskedTurn + 1) {
      if (/\b(rather not|no thanks|none of your|why do you need|not telling|prefer not)\b/i.test(text)) {
        this.nameDeclined = true;
        console.log('[Name] Caller declined to give a name');
        return;
      }
      const bare = text.replace(/^(yeah|yes|sure|okay|ok|hi|hey|hello|um+|uh+|so|well)[,.\s]+/i, '').replace(/[.!?,]+$/g, '').trim();
      const words = bare.split(/\s+/);
      if (words.length >= 1 && words.length <= 3 && words.every((w, i) => cap(w) || (i > 0 && /^[A-Z]\.?$/.test(w)))) {
        this.callerName = bare;
        console.log('[Name] Caller gave their name');
      }
    }
  }

  // Asks for the caller's name the way a person on the phone would: after
  // reacting to why they called, not as a gate in front of it. Returns null
  // when nothing should be asked this turn. Cached per turn so retries of the
  // same turn see the same hint.
  nameHint() {
    const t = this.callerTurns;
    if (this.nameHintCache?.turn === t) return this.nameHintCache.text;
    let text = null;
    const skip = this.callerName || this.nameDeclined || this.knownCaller?.name
      || this.bookingConfirmed || this.stage === 'agreed' || this.nameAsks >= 2;
    if (!skip && t >= 1) {
      const rules = 'Ask it as one short, casual question in your own words, never a form-style demand, and never "may I have your full name". If they already told you their name anywhere in this conversation, do not ask. If they sound distressed, in pain, in an emergency, angry or in a hurry, skip it now and help first; ask later once things are calmer. If they hesitate or decline, drop it and never ask again. Do not make it sound like a requirement.';
      if (this.nameAsks === 0 && t <= 3) {
        text = `Name: you do not know the caller's name yet and a real person would have it by now. In THIS reply, first react to or answer what they just said in a way that fits it, then ask who you are speaking with, in the same breath, for example "Happy to help with that, who am I speaking with?" or "Oh, I can sort that out. Can I get your name first?" If they only said hello and gave no reason yet, simply ask "Hi, who am I speaking with?" and then let them tell you why they called. ${rules}`;
      } else if (this.nameAsks === 1 && t >= this.nameAskedTurn + 2 && t <= 8) {
        text = `Name: you asked for their name earlier and still do not have it (they may have skipped it). Only if it fits the moment, ask once more, lightly, tucked into your reply, for example "By the way, who am I talking to?". If the moment does not fit, do not ask this turn. ${rules}`;
      }
    }
    this.nameHintCache = { turn: t, text };
    return text;
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

    const cta = (this.agentConfig?.main_call_to_action || 'a visit or appointment').trim();
    if (!this.bookingConfirmed) {
      if (this.stage === 'discover') {
        hints.push('Stage: still discovering. Do NOT suggest a visit, appointment, call-back or any next step yet. React to what they said and ask one specific follow-up about their situation (what exactly, how long, how bad, what they have already tried).');
      } else if (this.stage === 'qualified') {
        hints.push(`Stage: the caller is a genuine fit. If you have not already, make ONE soft next-step suggestion now in your own words, the way a person in your role naturally would (what the business wants from a good call: ${cta}). Do not mention booking systems, calendars or tools, and do not ask for personal details yet. If they answer vaguely, keep helping instead of pushing.`);
      } else if (this.stage === 'agreed') {
        hints.push(this.agreedHint());
      } else if (this.stage === 'declined') {
        hints.push('Stage: the caller does not want a next step right now. Do not push. Keep helping with what they asked, offer to take a message or send information if useful, and let THEM decide when the call is over. Do not wrap up on your own.');
      } else if (this.stage === 'not_fit') {
        hints.push('Stage: you may have misjudged this call. Do not wrap up or end it. Ask one gentle question to understand what they need. If it truly is something the business cannot do, say so kindly, point them to the right kind of help, offer to take a message, and stay on the line until they are done.');
      }
    }

    if (this.knownCaller?.name && !this.bookingConfirmed) {
      const first = this.knownCaller.name.split(/\s+/)[0];
      hints.push(`Returning caller: this phone number belongs to someone we know as ${this.knownCaller.name}, but it may be someone else using the phone. Do NOT assume. Early in this reply or the next natural moment, ask once, lightly: "Am I speaking with ${first}?" If yes, use their first name naturally from then on and, when you book, you already have their name (just say you are booking it under ${this.knownCaller.name}). If no, treat them as a new caller. Never mention past calls or any other detail you hold about them.`);
    }

    if (this.bookingConfirmed) {
      const b = this.bookingConfirmed;
      hints.push(`A booking is already confirmed on this call (${b.name}, ${b.date} at ${b.time}). Do not book again. Confirm it warmly in one sentence, ask if there is anything else, and close the call naturally.`);
    } else if (this.callerTurns >= firmTurns || elapsedSecs >= firmSecs) {
      hints.push('The call has gone on long without a clear next step. Wrap up now: offer to take a message, have the team follow up, or send information, then close warmly. Do not start new topics.');
    } else if (this.callerTurns >= softTurns || elapsedSecs >= softSecs) {
      hints.push('You have talked a while. If the caller has a real, specific need you can help with, make your soft next-step suggestion now. If not, start steering toward taking a message or closing politely.');
    }

    // Demo wind-down: at 85 s prompt a natural product mention + close.
    if (this.isDemo && this.demoStartedAt) {
      const demoSec = (Date.now() - this.demoStartedAt) / 1000;
      if (demoSec >= 85) {
        const left = Math.max(0, Math.ceil(100 - demoSec));
        hints.push({
          role: 'system',
          content: `DEMO ENDING (${left}s left): In your very next reply, weave in naturally — without breaking the conversation — something like: "Just so you know, I'm a live demo — if you'd like your own AI agent exactly like me, built for your business, get started at Knoxified dot org." Then close the call warmly within one or two more exchanges.`,
        });
      }
    }

    if (this.availabilityNotes.length) {
      const lines = this.availabilityNotes.map((n) => `${n.date}: ${n.summary}`).join(' | ');
      hints.push(`Availability already looked up on this call (use it, do not re-check unless the caller changes the day): ${lines}`);
    }

    const nameHint = this.nameHint();
    if (nameHint) hints.push(nameHint);
    else if (this.callerName && !this.bookingConfirmed) hints.push(`The caller's name is ${this.callerName}. Use it rarely and naturally (see the earlier rule), never ask for it again.`);

    return hints.map((content) => ({ role: 'system', content }));
  }

  // ---- silence handling ------------------------------------------------------

  markCallerActivity(text = '') {
    const now = Date.now();
    this.lastCallerActivityAt = now;
    this.silenceStage = 0;
    // Barge-in: real speech (2+ words) while the agent is mid-sentence stops the agent.
    const words = String(text).trim().split(/\s+/).filter(Boolean).length;
    if (words >= 2 && now < this.agentSpeakingUntil - 200 && now - this.speechStartedAt > 600) {
      this.interruptAgent();
    }
  }

  interruptAgent() {
    this.speakEpoch += 1; // abandons the sentence currently streaming
    this.agentSpeakingUntil = 0;
    this.lastInterruptAt = Date.now();
    console.log('[Call] Caller barged in, stopping agent audio');
    try {
      if (this.ws.readyState === 1) {
        const sidKey = (this.provider === 'twilio' || this.provider === 'web' || this.provider === 'browser') ? 'streamSid' : 'stream_sid';
        this.ws.send(JSON.stringify({ event: 'clear', [sidKey]: this.streamSid }));
      }
    } catch {
      /* socket already closing */
    }
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
        await this.hangUpAfterPlayback();
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
      '- Do not repeat their words back, do not summarise, do not list options (the one exception: confirming their name and email when booking). Answer what was asked, then stop. Not every reply needs a question.',
      '- Use their name rarely, at most once or twice in a whole call.',
      '- Short reactions are real speech: "mm-hm", "right", "oh no", "okay", "yeah". Sometimes a brief reaction plus one question is the whole reply. Vary them; never use the same one twice in a row.',
      '- Show you were listening: use their own words and details from earlier ("you said it gets worse at night") and never ask again something they already told you.',
      '- Let speech be a little imperfect: contractions, starting with "So," or "Well,", a dash or ellipsis for a thinking pause. Say numbers and times the way people do ("two thirty", "a couple of days").',
      '- Match their length. A brief caller gets a brief reply. Someone telling a story or upset gets a beat of acknowledgment before any question.',
      '- Never open with praise or filler like "Great question" or "Absolutely". Only state facts about the business that are in your notes; otherwise say you will check with the team.',
      '- Emotion: you may begin a reply with ONE marker when the moment clearly calls for it: [mood:sympathetic] (caller in pain, worried or upset), [mood:enthusiastic] (good news or excitement), [mood:calm] (tense or urgent), [mood:apologetic] (something went wrong), [mood:curious], [mood:confident], [mood:content]. Use it only when it fits, not on every reply, and never mention it.',
      '- If you do not know something, say so plainly and offer to have someone follow up.',
      '- If someone starts to give their name but you did not catch it (cut off or unclear), say so naturally and ask once, for example "Sorry, I missed your name, could you say it again?". Never carry on as if you heard it.',
      '- Never decide a caller is out of scope on your own. Ask what they mean first. Never say "that is outside our scope" or "take care" as a way to wrap up, and never offer to end the call. Only say goodbye once the caller is wrapping up.',
      '- Whenever you say the team will follow up, call them back or send something, first use take_message. On a web call you have no phone number: ask for the best number or email, read it back, get a yes, then use it. On a phone call you already have their number, so do not ask for it.',
      '- If someone says "help" or sounds distressed, slow down, say something caring, and ask what is happening before anything else.',
      '- Ending the call: when the caller has clearly finished (says bye, thanks that is all, nothing else) give one short warm goodbye and put the exact marker [END] at the very end of that final message. Use [END] only for that final goodbye, never mid-conversation, and never mention it. Do not offer more help after they have said they are done.',
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
      '- Only offer appointment times inside the business hours above.',
    );

    // Tone directive is HOW to speak (pace, warmth, formality), kept
    // distinct from systemPrompts below which is WHAT the business does --
    // the two answer different questions and get injected separately
    // rather than folded into one block.

    // memory_context is the free-text business summary the client wrote or
    // generated via the "scan my website" feature -- this is the actual
    // fix for "the agent has no memory of the business it's answering for".
    if (cfg.memory_context) {
      lines.push('', 'What you know about this business (use naturally, do not read this list back verbatim):', cfg.memory_context);
    }

    // Saved from the dashboard's website scan (the owner can edit both).
    if (cfg.website_summary) {
      lines.push('', 'From the business website:', String(cfg.website_summary).slice(0, 3000));
    }
    if (Array.isArray(cfg.faqs) && cfg.faqs.length) {
      const faqLines = [];
      let used = 0;
      for (const f of cfg.faqs) {
        const q = String(f?.q || '').trim();
        const a = String(f?.a || '').trim();
        if (!q || !a) continue;
        const entry = `Q: ${q}\nA: ${a}`;
        if (used + entry.length > 3000) break; // keep the prompt (and replies) fast
        faqLines.push(entry);
        used += entry.length;
      }
      if (faqLines.length) {
        lines.push('', 'Frequently asked questions (answer from these when relevant, in your own natural words, never recite them):', ...faqLines);
      }
    }

    lines.push('', 'If the caller asks a factual question about the business that is not covered in your notes above, do NOT guess or invent an answer. Use the take_question tool so the owner can follow up, and tell the caller the team will get back to them.');

    // Industry-specific tone/vocabulary from whichever Systems (verticals)
    // the client has activated -- e.g. plumbing calls talk about triage and
    // dispatch, dental calls stay reassuring and never give clinical advice.
    const systemBlock = [];
    if (this.toneDirective) systemBlock.push('', `Tone for this call: ${this.toneDirective}`);
    if (this.playbook) {
      systemBlock.push('', 'How a person in your role handles this call. This is your character and judgment: follow its spirit in your own words, never recite it:', this.playbook);
    }
    if (systemPrompts && systemPrompts.length > 0) {
      systemBlock.push('', 'Industry context for this business:');
      for (const p of systemPrompts) systemBlock.push(p);
    }

    const ownerBlock = [];
    if (cfg.negative_instructions) ownerBlock.push('', `Things to avoid: ${cfg.negative_instructions}`);
    if (cfg.custom_system_prompt) ownerBlock.push('', cfg.custom_system_prompt);

    if (systemBlock.length > 0) {
      // An industry system is active: the owner's own wording comes FIRST as
      // preferences, and the system's rules come last and win any conflict, so
      // a personal prompt can never break the system's behaviour or safety rules.
      if (ownerBlock.length) {
        lines.push('', 'The owner\'s own preferences (follow them where they do not conflict with the industry rules below):', ...ownerBlock);
      }
      lines.push(...systemBlock);
      lines.push('', 'The tone, role and industry rules above take priority over any conflicting preference or instruction earlier in this prompt. Never break their safety limits.');
    } else if (ownerBlock.length) {
      // No system: the owner's instructions are the only customisation and go last.
      lines.push(...ownerBlock);
    }

    lines.push('', `Today: ${new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Dates you pass to tools use the business timezone (${tz}). Upcoming days (use these exact dates, never work out dates yourself): ${upcomingDays(tz)}.`);

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
      // Only calls where the caller actually said something become leads --
      // a hang-up during the greeting or a silent line is not a lead.
      const callerSpoke = this.messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0
      );

      // Outcome comes from facts about the call; the summary is best-effort.
      const outcome = decideOutcome({
        callerSpoke,
        bookingConfirmed: !!this.bookingConfirmed,
        questionsLogged: this.questionsLogged,
        followUp: !!this.followUp,
      });
      const analysis = await buildCallSummary(this.env, { messages: this.messages, outcome });
      const summary = analysis.summary;

      await saveCallTranscript(
        this.env,
        this.userId,
        this.callId,
        this.callerNumber,
        this.provider,
        durationSecs,
        this.messages,
        { summary, outcome }
      );

      if (callerSpoke) {
        // Every call where the caller spoke is logged on the Leads page, including web
        // calls and dashboard previews (no phone number). A name/email the caller
        // confirmed for a booking wins; a name they simply said only fills an empty slot.
        const detail = {
          reason: analysis.reason,
          urgency: analysis.urgency,
          tone: analysis.tone,
          summary,
          appointmentBooked: outcome === 'booked',
          name: this.capturedContact?.name || this.followUp?.name || analysis.name,
          email: this.capturedContact?.email || null,
          followUp: this.followUp,
        };
        const leadId = await recordCallLead(this.env, this.userId, {
          phone: this.callerNumber,
          callId: this.callId,
          seconds: durationSecs,
          preview: !!this.systemTypeOverride,
          system: this.effectiveSystemType,
        });
        if (leadId) {
          await saveLeadDetailsById(this.env, leadId, detail);
        } else if (this.callerNumber) {
          // record_call_lead not migrated yet: original phone-only path.
          await recordInboundLead(this.env, this.userId, this.callerNumber, this.callId);
          await saveContactToLead(this.env, this.userId, this.callerNumber, { name: detail.name, email: detail.email });
          await saveLeadCallDetails(this.env, this.userId, this.callerNumber, detail);
        }
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
  take_question: ['Let me make a note of that.', 'Good question, let me note that down.'],
  book_appointment: ['Give me a moment while I get that set up.', 'One moment, I am booking that for you now.', 'Bear with me a second while I lock that in.'],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickFiller(toolName) {
  return pickRandom(FILLERS[toolName] || ['One moment.']);
}

const FAREWELL_RE = /\b(take care|goodbye|good bye|bye|have a (great|good|nice|wonderful|lovely) (day|one|evening|night|week)|talk (to you )?soon|speak soon)\b/i;
const CALLER_CLOSING_RE = /\b(bye|goodbye|that'?s (all|it)|nothing else|no,? (thanks|thank you)|(ok(ay)?|alright|great|perfect|cool|sure)[.,!\s]+thank(s| you)|thank(s| you)[.,!\s]+(bye|that'?s all))\b/i;

// gpt-oss occasionally returns its reply twice back to back; speak it once.
function dedupeRepeat(text) {
  const t = String(text || '').trim();
  const n = t.length;
  if (n < 20) return t;
  for (const cut of [Math.floor(n / 2), Math.ceil(n / 2)]) {
    const a = t.slice(0, cut).trim();
    const b = t.slice(cut).trim();
    if (a && a === b) return a;
  }
  return t;
}

// "Wed 2026-10-14 (today), Thu 2026-10-15 (tomorrow), Fri 2026-10-16, ..." in the
// business timezone, so the model looks dates up instead of doing day maths.
function upcomingDays(timeZone, n = 14) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const d = new Date(now + i * 86400000);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    out.push(`${wd} ${ymd}${i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''}`);
  }
  return out.join(', ');
}
