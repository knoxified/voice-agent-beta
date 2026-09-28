// Owner-defined call routing rules, stored on agent_configs.custom_intents.
//
// Shape of one rule (written by the dashboard's "Call routing" editor):
//   { label, keywords: string[], action: 'transfer' | 'reply', reply?: string }
//
// - 'transfer' hands the live call to the account's own business_phone
//   (never an arbitrary number -- one destination per account).
// - 'reply' speaks a fixed answer instead of calling the LLM.
//
// The dashboard validates on save, but this file re-validates on load
// because the column is plain jsonb and anything could be in it.

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_RULES = 10;
const MAX_KEYWORDS = 10;

function isValidE164(n) {
  return typeof n === 'string' && E164.test(n);
}

function sanitizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw.slice(0, MAX_RULES)) {
    if (!r || typeof r !== 'object') continue;
    const action = r.action === 'transfer' || r.action === 'reply' ? r.action : null;
    if (!action) continue;

    const keywords = (Array.isArray(r.keywords) ? r.keywords : [])
      .filter((k) => typeof k === 'string')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length >= 2 && k.length <= 40)
      .slice(0, MAX_KEYWORDS);
    if (keywords.length === 0) continue;

    const reply = typeof r.reply === 'string' ? r.reply.trim().slice(0, 300) : '';
    if (action === 'reply' && !reply) continue;

    out.push({
      label: typeof r.label === 'string' ? r.label.trim().slice(0, 60) : '',
      keywords,
      action,
      reply,
    });
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// First rule (in the owner's order) with a keyword found as a whole word/phrase.
function matchRoutingRule(rules, transcript) {
  if (!transcript || !rules || rules.length === 0) return null;
  const text = transcript.toLowerCase();
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(kw)}([^a-z0-9]|$)`, 'i');
      if (re.test(text)) return rule;
    }
  }
  return null;
}

export { isValidE164, sanitizeRules, matchRoutingRule };
