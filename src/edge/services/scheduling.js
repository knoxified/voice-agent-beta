// Deterministic scheduling helpers. The model is bad at date arithmetic and
// tends to re-check or invent times, so the code does the lookups: it turns
// what the caller said ("next Friday", "2PM") into a real date and a real
// open slot, and the model is only told the result.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// [{ ymd, wd, month, dayNum, i }] for today + the next n-1 days in `tz`.
export function upcomingList(tz, n = 22, now = Date.now()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now + i * 86400000);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d).toLowerCase();
    out.push({ ymd, wd, month: MONTHS[Number(ymd.slice(5, 7)) - 1], dayNum: Number(ymd.slice(8, 10)), i });
  }
  return out;
}

// The day the caller is talking about, as YYYY-MM-DD, or null. The LAST
// mention wins so self-corrections ("Thursday, no, Friday") work.
export function parseDayMention(text, tz, now = Date.now()) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const days = upcomingList(tz, 22, now);
  const hits = [];
  const add = (idx, ymd) => ymd && hits.push({ idx, ymd });

  for (const m of t.matchAll(/\bday after tomorrow\b/g)) add(m.index, days[2]?.ymd);
  for (const m of t.matchAll(/\btomorrow\b/g)) add(m.index, days[1]?.ymd);
  for (const m of t.matchAll(/\btoday\b/g)) add(m.index, days[0]?.ymd);

  for (const m of t.matchAll(/\b(?:(next|this|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const matches = days.filter((d) => d.i >= 1 && d.wd === m[2]);
    const pick = m[1] === 'next' ? matches[1] : matches[0];
    add(m.index, pick?.ymd);
  }

  const monthRe = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const byMonthDay = (mon, day) => days.find((d) => d.month === mon.slice(0, 3) && d.dayNum === Number(day))?.ymd;
  for (const m of t.matchAll(new RegExp(`\\b${monthRe}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) add(m.index, byMonthDay(m[1], m[2]));
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthRe}\\b`, 'g'))) add(m.index, byMonthDay(m[2], m[1]));
  for (const m of t.matchAll(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/g)) add(m.index, days.find((d) => d.i >= 1 && d.dayNum === Number(m[1]))?.ymd);
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index, days.find((d) => d.ymd === m[0])?.ymd);

  if (!hits.length) return null;
  hits.sort((a, b) => a.idx - b.idx);
  return hits[hits.length - 1].ymd;
}

const HOUR_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// A clock time the caller named, as { hour, minute, meridiem|null }, or null.
// The LAST mention wins ("1AM. No. 1PM." -> 1 PM).
export function parseTimeMention(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const hits = [];

  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/g)) {
    hits.push({ idx: m.index, hour: Number(m[1]), minute: Number(m[2] || 0), meridiem: m[3] === 'p' ? 'pm' : 'am' });
  }
  for (const m of t.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(thirty|fifteen|forty[- ]five))?\s*([ap])\.?\s?m\b\.?/g)) {
    const mins = m[2] ? { thirty: 30, fifteen: 15 }[m[2]] ?? 45 : 0;
    hits.push({ idx: m.index, hour: HOUR_WORDS[m[1]], minute: mins, meridiem: m[3] === 'p' ? 'pm' : 'am' });
  }
  for (const m of t.matchAll(/\bnoon\b/g)) hits.push({ idx: m.index, hour: 12, minute: 0, meridiem: 'pm' });
  // "go with 2", "let's do 2:30" (no am/pm; ambiguity is resolved against the open slots)
  for (const m of t.matchAll(/\b(?:go with|take|pick|let'?s do|make it|works? at|how about|around|at)\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:st|nd|rd|th|[ap]\.?\s?m|o'?clock\s+tomorrow))/g)) {
    const hour = Number(m[1]);
    if (hour >= 1 && hour <= 23) hits.push({ idx: m.index, hour, minute: Number(m[2] || 0), meridiem: null });
  }

  if (!hits.length) return null;
  hits.sort((a, b) => a.idx - b.idx);
  const h = hits[hits.length - 1];
  if (h.hour > 23 || h.minute > 59) return null;
  return { hour: h.hour, minute: h.minute, meridiem: h.meridiem };
}

function hhmmInZone(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('hour')}:${get('minute')}`;
}

export function labelFromHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const mer = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${mer}`;
}

// Match a named clock time to a really open slot. Returns
//   { time: 'HH:MM', label }          open: lock it in
//   { notOpen: true, label }          they asked for a time that is not open
//   null                              nothing usable / ambiguous
export function matchSlot(slotStarts, parsed, tz) {
  if (!slotStarts || !parsed) return null;
  const open = new Map(); // 'HH:MM' -> ms
  for (const ms of slotStarts) open.set(hhmmInZone(ms, tz), ms);

  const candidates = [];
  const mm = String(parsed.minute).padStart(2, '0');
  if (parsed.meridiem) {
    const h24 = (parsed.hour % 12) + (parsed.meridiem === 'pm' ? 12 : 0);
    candidates.push(`${String(h24).padStart(2, '0')}:${mm}`);
  } else if (parsed.hour >= 13) {
    candidates.push(`${String(parsed.hour).padStart(2, '0')}:${mm}`);
  } else {
    candidates.push(`${String(parsed.hour % 12).padStart(2, '0')}:${mm}`);
    candidates.push(`${String((parsed.hour % 12) + 12).padStart(2, '0')}:${mm}`);
  }
  const found = candidates.filter((c) => open.has(c));
  if (found.length === 1) return { time: found[0], label: labelFromHHMM(found[0]) };
  if (found.length > 1) return null; // e.g. 9:00 and 21:00 both open: let the agent ask
  const guess = candidates[candidates.length - 1];
  const label = parsed.meridiem ? labelFromHHMM(candidates[0]) : `${parsed.hour}:${mm}`;
  return { notOpen: true, label, guess };
}

// Consecutive 15-minute start times collapsed into ranges for the model:
// ["10:00 AM to 12:30 PM", "1:00 PM to 5:45 PM"] (a gap means busy).
export function rangesLabels(slotStarts, tz) {
  const sorted = [...new Set(slotStarts)].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== undefined && cur - prev === 15 * 60000) {
      prev = cur;
      continue;
    }
    ranges.push([start, prev]);
    start = cur;
    prev = cur;
  }
  return ranges.map(([a, b]) => (a === b ? labelFromHHMM(hhmmInZone(a, tz)) : `${labelFromHHMM(hhmmInZone(a, tz))} to ${labelFromHHMM(hhmmInZone(b, tz))}`));
}

export function dayLabel(ymd, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
}
