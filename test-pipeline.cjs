// ─── Pipeline test — run with: node test-pipeline.js ──────
// Tests the AI brain without needing a Telnyx number
// Simulates what would happen during a real call

require('dotenv').config();

const { generateResponse } = require('./src/services/llm');
const { synthesizeSpeech } = require('./src/services/tts');
const { detectIntent, buildN8nPayload } = require('./src/services/intent');
const fs = require('fs');

async function runTest() {
  console.log('\n═══════════════════════════════════════');
  console.log('  Knoxified Voice — Pipeline Test');
  console.log('═══════════════════════════════════════\n');

  // Simulated tenant session
  const mockSession = {
    tenantId: 'test-tenant-001',
    tenantName: 'Lagos Dental Clinic',
    agentPersona: 'friendly dental receptionist',
    callerNumber: '+2348012345678',
    plan: 'pro',
    messages: [
      {
        role: 'system',
        content: `You are a friendly dental receptionist for Lagos Dental Clinic.
Keep responses concise — this is a phone call.
Respond in 1-3 sentences maximum.
Do not use markdown or bullet points.
Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`
      }
    ]
  };

  // Test conversations
  const testInputs = [
    "Hello, I'd like to book an appointment please",
    "My name is Chidi and I need a cleaning",
    "Can I come in tomorrow at 2pm?",
    "What are your opening hours?"
  ];

  for (const userInput of testInputs) {
    console.log(`\n▶ User: "${userInput}"`);

    // Check intent detection
    const intent = detectIntent(userInput);
    if (intent) {
      console.log(`  Intent detected: ${intent.type}`);
    }

    // Add to conversation
    mockSession.messages.push({ role: 'user', content: userInput });

    try {
      // Test LLM
      console.log('  Calling Groq...');
      const start = Date.now();
      const response = await generateResponse(mockSession.messages);
      const llmTime = Date.now() - start;

      console.log(`  ◀ AI (${llmTime}ms): "${response}"`);

      // Add response to history
      mockSession.messages.push({ role: 'assistant', content: response });

      // Test TTS
      if (process.env.TTS_PROVIDER === 'cartesia' && process.env.CARTESIA_API_KEY) {
        console.log('  Generating speech with Cartesia...');
        const ttsStart = Date.now();
        const audio = await synthesizeSpeech(response);
        const ttsTime = Date.now() - ttsStart;

        if (audio && !audio.__telnyxNativeTTS) {
          console.log(`  ✓ Audio generated (${ttsTime}ms) — ${audio.length} bytes`);

          // Save first audio file so you can listen to it
          if (testInputs.indexOf(userInput) === 0) {
            fs.writeFileSync('test-audio-sample.raw', audio);
            console.log('  ✓ Audio saved to test-audio-sample.raw');
          }
        }
      } else {
        console.log('  TTS: Using Telnyx native (no audio bytes generated in test)');
      }

    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
    }

    // Small delay between turns
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n═══════════════════════════════════════');
  console.log('  Test complete');
  console.log('═══════════════════════════════════════\n');

  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
