// This exact string is user_voice_settings.agent_greeting's DB-level
// default -- present on basically every row that's never been hand-edited,
// not a real customization. Treated the same as "unset" so those accounts
// get the personalized greeting below instead of the old generic one.
const GENERIC_DEFAULT_GREETING = 'Hello, thank you for calling. How can I help you?';

// Builds "Hi, this is Alice from Knoxified, how can I help you today?" from
// the client's actual configured agent name + company name, or fills
// {{agent_name}}/{{company_name}} into a custom greeting if they wrote one
// using those placeholders.
function buildGreeting(agentConfig, customGreeting) {
  const cfg = agentConfig || {};
  const agentName = cfg.agent_nickname || 'your assistant';
  const companyName = cfg.organization_name || 'this business';

  if (customGreeting && customGreeting.trim().length > 0 && customGreeting.trim() !== GENERIC_DEFAULT_GREETING) {
    return customGreeting
      .replace(/\{\{\s*agent_name\s*\}\}/gi, agentName)
      .replace(/\{\{\s*company_name\s*\}\}/gi, companyName);
  }
  return `Hi, this is ${agentName} from ${companyName}. How can I help you today?`;
}

export { buildGreeting, GENERIC_DEFAULT_GREETING };
