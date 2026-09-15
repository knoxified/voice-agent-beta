// CommonJS mirror of src/edge/services/greeting.js -- that file is an ES
// module and this half of the codebase uses require(), so rather than risk
// an untested cross-module-system import, this keeps the same logic
// available natively here. Keep both in sync if the substitution rules
// change.

const GENERIC_DEFAULT_GREETING = 'Hello, thank you for calling. How can I help you?';

// Real-world disclosure research consistently favors two things over a
// bolted-on disclaimer: (1) familiar, well-worn phrasing -- unusual wording
// draws more attention to itself and reads as more alarming, while a
// phrase callers have heard on countless other business calls processes as
// routine; (2) folding it into the natural greeting instead of appending a
// separate sentence at the end, so the call ends on the helpful question,
// not lingering on the recording note.
const RECORDING_NOTICE = 'on a recorded line for quality assurance';

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

module.exports = { buildGreeting, GENERIC_DEFAULT_GREETING, RECORDING_NOTICE };
