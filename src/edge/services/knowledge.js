// Keeps the system prompt small without deleting anything the owner wrote.
// Short knowledge is inlined as before. Long knowledge (many FAQs, a long
// website summary) is split into chunks, and each turn only the few chunks that
// match what the caller is talking about are added as a note. Plain keyword
// overlap: no model call, no latency, no extra quota.

const STOP = new Set(('the and for are but not you your with this that have has had was were will would can could should from they them their there what when where which who how why about into onto over under than then also just like very much more most some any all our out its it\'s i\'m don\'t do does did get got let make want need please thanks thank okay yeah yes hello').split(' '));

export function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ''));
}

export function splitChunks(text, maxLen = 400) {
  const parts = String(text || '').split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).length > maxLen && cur) { out.push(cur); cur = p; } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

// chunks: strings. Returns the best-matching ones (in original order) within maxChars.
export function pickRelevant(chunks, queryText, maxChars = 900, maxCount = 3) {
  const q = new Set(words(queryText));
  if (!q.size) return [];
  const scored = chunks.map((c, i) => {
    const w = words(c);
    let hits = 0;
    for (const t of new Set(w)) if (q.has(t)) hits += 1;
    return { c, i, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits || a.i - b.i);
  const chosen = [];
  let used = 0;
  for (const x of scored) {
    if (chosen.length >= maxCount || used + x.c.length > maxChars) continue;
    chosen.push(x); used += x.c.length;
  }
  return chosen.sort((a, b) => a.i - b.i).map((x) => x.c);
}
