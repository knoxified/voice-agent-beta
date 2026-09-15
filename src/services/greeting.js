// CommonJS mirror of src/edge/services/greeting.js -- that file is an ES
// module and this half of the codebase uses require(), so rather than risk
// an untested cross-module-system import, this keeps the same logic
// available natively here. Keep both in sync if the substitution rules
// change.

const GENERIC_DEFAULT_GREETING = 'Hello, thank you for calling. How can I help you?';

const RECORDING_DISCLOSURE = "Just so you know, this call may be recorded for quality and training purposes.";

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

module.exports = { buildGreeting, GENERIC_DEFAULT_GREETING, RECORDING_DISCLOSURE };
