// This exact string is user_voice_settings.agent_greeting's DB-level
// default -- present on basically every row that's never been hand-edited,
// not a real customization. Treated the same as "unset" so those accounts
// get the personalized greeting below instead of the old generic one.
const GENERIC_DEFAULT_GREETING = 'Hello, thank you for calling. How can I help you?';

// Real-world disclosure research consistently favors two things over a
// bolted-on disclaimer: (1) familiar, well-worn phrasing -- unusual wording
// draws more attention to itself and reads as more alarming, while a
// phrase callers have heard on countless other business calls processes as
// routine; (2) folding it into the natural greeting instead of appending a
// separate sentence at the end, so the call ends on the helpful question,
// not lingering on the disclosure note.
const RECORDING_NOTICE = 'on a recorded line for quality assurance';

// Separate from the recording notice -- some jurisdictions require telling
// the caller they are speaking with an AI. Owner-controlled via
// agent_configs.ai_disclosure_enabled (off by default; the dashboard shows
// a red warning that it should normally be on). Never forced on here.
const AI_DISCLOSURE_NOTICE = 'an AI agent';

// Builds the opening line from the client's actual configured agent name +
// company name, or fills a custom greeting's placeholders if they wrote
// one. Accepts both the short ({{agent}}/{{company}}) and long
// ({{agent_name}}/{{company_name}}) forms -- someone typing a custom
// greeting has no way to know which exact syntax the system expects, and a
// silently-unreplaced placeholder spoken aloud on a real call is a much
// worse failure than being lenient about the syntax.
//
// A custom greeting can place either disclosure exactly where it wants
// with {{recording_notice}} / {{ai_disclosure}}; if it doesn't, whichever
// disclosures are switched ON are folded into the greeting automatically --
// a custom greeting can never suppress an enabled disclosure just by
// omitting it. When a toggle is OFF its placeholder renders as nothing.
function buildGreeting(agentConfig, customGreeting, recordingEnabled = false, aiDisclosureEnabled = false) {
  const cfg = agentConfig || {};
  const agentName = cfg.agent_nickname || 'your assistant';
  const companyName = cfg.organization_name || 'this business';

  // Default opening: "Hi/Hello, this is <name> from <company>[, an AI agent][, on a recorded line
  // for quality assurance]. How can I help you today?" Each clause appears only when its toggle is
  // on. Even with the AI clause off, the agent never claims to be human and says it is an AI if a
  // caller sincerely asks (see the system prompt).
  const hasCompany = !!(cfg.organization_name && String(cfg.organization_name).trim());
  const who = `${agentName}${hasCompany ? ` from ${companyName}` : ''}`;
  const opener = Math.random() < 0.5 ? 'Hi' : 'Hello';
  const clauses = [];
  if (aiDisclosureEnabled) clauses.push(AI_DISCLOSURE_NOTICE);
  if (recordingEnabled) clauses.push(RECORDING_NOTICE);
  const identityClause = `${opener}, this is ${who}${clauses.length ? `, ${clauses.join(', ')}` : ''}.`;
  const defaultGreeting = `${identityClause} How can I help you today?`;

  if (customGreeting && customGreeting.trim().length > 0 && customGreeting.trim() !== GENERIC_DEFAULT_GREETING) {
    let greeting = customGreeting
      .replace(/\{\{\s*agent_name\s*\}\}/gi, agentName)
      .replace(/\{\{\s*agent\s*\}\}/gi, agentName)
      .replace(/\{\{\s*company_name\s*\}\}/gi, companyName)
      .replace(/\{\{\s*company\s*\}\}/gi, companyName)
      .replace(/\{\{\s*business_name\s*\}\}/gi, companyName)
      .replace(/\{\{\s*business\s*\}\}/gi, companyName);

    const hasRecordingPlaceholder = /\{\{\s*recording_notice\s*\}\}/i.test(greeting);
    const hasAiPlaceholder = /\{\{\s*ai_disclosure\s*\}\}/i.test(greeting);
    greeting = greeting
      .replace(/\{\{\s*recording_notice\s*\}\}/gi, recordingEnabled ? RECORDING_NOTICE : '')
      .replace(/\{\{\s*ai_disclosure\s*\}\}/gi, aiDisclosureEnabled ? AI_DISCLOSURE_NOTICE : '');

    // A placeholder switched off leaves a dangling comma/space behind; tidy it.
    greeting = greeting.replace(/\s*,\s*(?=[.!?])/g, '').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();

    const leftover = greeting.match(/\{\{\s*[\w-]+\s*\}\}/);
    if (leftover) {
      console.error('[Greeting] Unrecognized placeholder survived substitution:', leftover[0], '-- falling back to default greeting');
      return defaultGreeting;
    }

    // Whichever disclosures the custom greeting didn't explicitly place get
    // folded in right after the greeting's first clause rather than
    // appended as an afterthought -- and this always happens regardless of
    // what the custom text says, so a custom greeting can never silently
    // omit a required disclosure just by not mentioning it.
    // Inserted as its own short sentence right after the greeting's first
    // sentence. Splicing the notices into the first clause reads as if the
    // company itself is "an AI assistant" ("this is Alice from Acme, an AI
    // assistant"), so a separate sentence is both clearer and legally safer.
    const missingParts = [];
    if (aiDisclosureEnabled && !hasAiPlaceholder) missingParts.push(`you're speaking with ${AI_DISCLOSURE_NOTICE}`);
    if (recordingEnabled && !hasRecordingPlaceholder) missingParts.push(`this call is ${RECORDING_NOTICE}`);

    if (missingParts.length > 0) {
      const joined = `${missingParts.join(', and ')}.`;
      const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
      const firstSentenceEnd = greeting.search(/[.!?]/);
      if (firstSentenceEnd > -1) {
        greeting = `${greeting.slice(0, firstSentenceEnd + 1)} ${sentence}${greeting.slice(firstSentenceEnd + 1)}`;
      } else {
        greeting = `${greeting}. ${sentence}`;
      }
    }

    return greeting;
  }

  return defaultGreeting;
}

export { buildGreeting, GENERIC_DEFAULT_GREETING, RECORDING_NOTICE, AI_DISCLOSURE_NOTICE };
