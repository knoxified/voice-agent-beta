// This exact string is user_voice_settings.agent_greeting's DB-level
// default -- present on basically every row that's never been hand-edited,
// not a real customization. Treated the same as "unset" so those accounts
// get the personalized greeting below instead of the old generic one.
const GENERIC_DEFAULT_GREETING = 'Hello, thank you for calling. How can I help you?';

// Required before the conversation proceeds whenever call recording is on
// -- recording a call without disclosing it is illegal in two-party-consent
// jurisdictions and a real compliance risk regardless of jurisdiction.
// Appended naturally to the end of the greeting, not read as a separate
// robotic disclaimer.
const RECORDING_DISCLOSURE = "Just so you know, this call may be recorded for quality and training purposes.";

// Builds "Hi, this is Alice from Knoxified, how can I help you today?" from
// the client's actual configured agent name + company name, or fills a
// custom greeting's placeholders if they wrote one. Accepts both the short
// ({{agent}}/{{company}}) and long ({{agent_name}}/{{company_name}}) forms
// -- someone typing a custom greeting has no way to know which exact syntax
// the system expects, and a silently-unreplaced placeholder spoken aloud on
// a real call is a much worse failure than being lenient about the syntax.
// Appends the recording disclosure at the end when recordingEnabled is true.
function buildGreeting(agentConfig, customGreeting, recordingEnabled = false) {
  const cfg = agentConfig || {};
  const agentName = cfg.agent_nickname || 'your assistant';
  const companyName = cfg.organization_name || 'this business';

  let greeting;
  if (customGreeting && customGreeting.trim().length > 0 && customGreeting.trim() !== GENERIC_DEFAULT_GREETING) {
    greeting = customGreeting
      .replace(/\{\{\s*agent_name\s*\}\}/gi, agentName)
      .replace(/\{\{\s*agent\s*\}\}/gi, agentName)
      .replace(/\{\{\s*company_name\s*\}\}/gi, companyName)
      .replace(/\{\{\s*company\s*\}\}/gi, companyName)
      .replace(/\{\{\s*business_name\s*\}\}/gi, companyName)
      .replace(/\{\{\s*business\s*\}\}/gi, companyName);

    // Safety net: if anything shaped like {{...}} survived all the known
    // patterns above, it's an unrecognized placeholder -- log it so it can
    // be added, and fall back to the safe auto-built greeting rather than
    // let an unreplaced {{whatever}} get spoken on a real call.
    const leftover = greeting.match(/\{\{\s*[\w-]+\s*\}\}/);
    if (leftover) {
      console.error('[Greeting] Unrecognized placeholder survived substitution:', leftover[0], '-- falling back to default greeting');
      greeting = `Hi, this is ${agentName} from ${companyName}. How can I help you today?`;
    }
  } else {
    greeting = `Hi, this is ${agentName} from ${companyName}. How can I help you today?`;
  }

  return recordingEnabled ? `${greeting} ${RECORDING_DISCLOSURE}` : greeting;
}

export { buildGreeting, GENERIC_DEFAULT_GREETING, RECORDING_DISCLOSURE };
