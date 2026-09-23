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

// Separate legal requirement from recording disclosure -- some
// jurisdictions require disclosing that the caller is speaking with an AI.
// agent_configs.require_ai_disclosure existed as a real column with no
// code anywhere actually acting on it before this.
const AI_DISCLOSURE_NOTICE = 'an AI assistant';

// Builds the opening line from the client's actual configured agent name +
// company name, or fills a custom greeting's placeholders if they wrote
// one. Accepts both the short ({{agent}}/{{company}}) and long
// ({{agent_name}}/{{company_name}}) forms -- someone typing a custom
// greeting has no way to know which exact syntax the system expects, and a
// silently-unreplaced placeholder spoken aloud on a real call is a much
// worse failure than being lenient about the syntax.
//
// A custom greeting can place either disclosure exactly where it wants
// with {{recording_notice}} / {{ai_disclosure}}; if it doesn't, both are
// folded into the greeting automatically -- a custom greeting can NEVER
// suppress either disclosure just by omitting it. This is deliberate:
// recording and AI disclosure are legal requirements, not stylistic
// choices a customer's wording should be able to opt out of.
function buildGreeting(agentConfig, customGreeting, recordingEnabled = false, aiDisclosureRequired = true) {
  const cfg = agentConfig || {};
  const agentName = cfg.agent_nickname || 'your assistant';
  const companyName = cfg.organization_name || 'this business';

  // Default opening: "Hello, this is <name>" -- a warm, person-first
  // opener -- followed by whichever disclosures apply in the SAME clause,
  // then a question so the caller knows it is their turn to speak. The
  // agent name is whatever the account has (the DB default is "Alex" until
  // the customer names it themselves). Disclosure is never optional here:
  // it is legally required up front in some jurisdictions. A custom
  // greeting can still say the business name via {{company}}.
  const identity = aiDisclosureRequired ? `${agentName}, an AI assistant` : agentName;
  const identityClause = recordingEnabled
    ? `Hello, this is ${identity}, ${RECORDING_NOTICE}.`
    : `Hello, this is ${identity}.`;
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
      .replace(/\{\{\s*ai_disclosure\s*\}\}/gi, aiDisclosureRequired ? AI_DISCLOSURE_NOTICE : '');

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
    if (aiDisclosureRequired && !hasAiPlaceholder) missingParts.push("I'm an AI assistant");
    if (recordingEnabled && !hasRecordingPlaceholder) missingParts.push(`this call is ${RECORDING_NOTICE}`);

    if (missingParts.length > 0) {
      const sentence = `${missingParts.join(', and ')}.`;
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
