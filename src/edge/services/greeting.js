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
// not lingering on the recording note.
const RECORDING_NOTICE = 'on a recorded line for quality assurance';

// Builds "Hi, this is Alice from Knoxified, how can I help you today?" from
// the client's actual configured agent name + company name, or fills a
// custom greeting's placeholders if they wrote one. Accepts both the short
// ({{agent}}/{{company}}) and long ({{agent_name}}/{{company_name}}) forms
// -- someone typing a custom greeting has no way to know which exact syntax
// the system expects, and a silently-unreplaced placeholder spoken aloud on
// a real call is a much worse failure than being lenient about the syntax.
// A custom greeting can place the recording notice exactly where it wants
// with {{recording_notice}}; if it doesn't, the notice is folded into the
// first sentence rather than appended as an afterthought.
function buildGreeting(agentConfig, customGreeting, recordingEnabled = false) {
  const cfg = agentConfig || {};
  const agentName = cfg.agent_nickname || 'your assistant';
  const companyName = cfg.organization_name || 'this business';
  const notice = recordingEnabled ? RECORDING_NOTICE : '';

  if (customGreeting && customGreeting.trim().length > 0 && customGreeting.trim() !== GENERIC_DEFAULT_GREETING) {
    let greeting = customGreeting
      .replace(/\{\{\s*agent_name\s*\}\}/gi, agentName)
      .replace(/\{\{\s*agent\s*\}\}/gi, agentName)
      .replace(/\{\{\s*company_name\s*\}\}/gi, companyName)
      .replace(/\{\{\s*company\s*\}\}/gi, companyName)
      .replace(/\{\{\s*business_name\s*\}\}/gi, companyName)
      .replace(/\{\{\s*business\s*\}\}/gi, companyName);

    const hasNoticePlaceholder = /\{\{\s*recording_notice\s*\}\}/i.test(greeting);
    greeting = greeting.replace(/\{\{\s*recording_notice\s*\}\}/gi, notice);

    const leftover = greeting.match(/\{\{\s*[\w-]+\s*\}\}/);
    if (leftover) {
      console.error('[Greeting] Unrecognized placeholder survived substitution:', leftover[0], '-- falling back to default greeting');
      return recordingEnabled
        ? `Hi, this is ${agentName} from ${companyName}, ${notice}. How can I help you today?`
        : `Hi, this is ${agentName} from ${companyName}. How can I help you today?`;
    }

    // Custom greeting had no explicit placement for the notice -- fold it
    // in right after the greeting's first clause rather than tack it onto
    // the very end, so it doesn't become the last (most memorable) thing
    // said before the caller has to respond.
    if (recordingEnabled && !hasNoticePlaceholder) {
      const firstSentenceEnd = greeting.search(/[.!?]/);
      if (firstSentenceEnd > -1) {
        greeting = `${greeting.slice(0, firstSentenceEnd)}, ${notice}${greeting.slice(firstSentenceEnd)}`;
      } else {
        greeting = `${greeting}, ${notice}.`;
      }
    }

    return greeting;
  }

  return recordingEnabled
    ? `Hi, this is ${agentName} from ${companyName}, ${notice}. How can I help you today?`
    : `Hi, this is ${agentName} from ${companyName}. How can I help you today?`;
}

export { buildGreeting, GENERIC_DEFAULT_GREETING, RECORDING_NOTICE };
