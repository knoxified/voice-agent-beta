// Correcting a heard email piece by piece, the way a person would.
//
// Once we have a best guess, the guess becomes a DRAFT where every character can be locked.
// The caller says things like:
//   "yes knox, but it's favour with an f"   -> "knox" is locked as right, "zavour" becomes "favour"
//   "the z is an f" / "it's 29 not 28"      -> only that letter / number changes
//   "no dots" / "dot after knox"            -> dots only change when the caller says so
// Locked characters are never changed by loose speech-to-text noise (accent, mishearing). They only
// change when the caller is clearly re-doing that part: spelling it out letter by letter, saying
// "not knox", or insisting twice. Pure functions, no I/O.

import { editDistance, parseNumberRun, isNumWord, stripInvisible } from './emailCapture.js';

export function newDraft(email) {
  const [local, domain] = String(email).split('@');
  return { local: [...local].map((c) => ({ c, l: false })), domain, domainLocked: false, conflicts: 0, target: null };
}
export const draftLocal = (d) => d.local.map((x) => x.c).join('');
export const draftEmail = (d) => `${draftLocal(d)}@${d.domain}`;

const NEGATORS = new Set(['not', "isn't", 'isnt', 'instead', 'rather', 'wrong', 'incorrect']);
const FILL = new Set([
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'but', 'it', 'its', "it's", 'is', 'was', 'the', 'a', 'an', 'that', 'thats', "that's",
  'right', 'correct', 'okay', 'ok', 'so', 'and', 'with', 'as', 'in', 'for', 'should', 'be', 'i', 'said', 'say', 'spell', 'like',
  'letter', 'letters', 'first', 'second', 'third', 'last', 'part', 'email', 'address', 'my', 'mean', 'meant', 'actually', 'sorry',
  'then', 'to', 'of', 'you', 'got', 'have', 'has', 'need', 'needs', 'change', 'add', 'remove', 'dot', 'dots', 'at', 'sign', 'gmail',
  'com', 'end', 'ends', 'ending', 'starts', 'start', 'beginning', 'after', 'before', 'between', 'number', 'numbers', 'only', 'just',
  'know', 'dont', 'write', 'how', 'numeric', 'type', 'typed', 'spelled', 'spelling', 'confirm', 'let', 'me', 'think', 'honestly', 'really', 'because', 'wait', 'hmm', 'um', 'uh', 'well', 'one', 'more', 'time', 'again', 'please', 'thanks', 'thank', 'sure', 'what', 'did', 'do',
]);

// ---- turning the caller's sentence into pieces ------------------------------------

function chunksOf(utterance) {
  const t = stripInvisible(utterance).toLowerCase().replace(/[.,!?;:"“”()]/g, ' ').replace(/[’]/g, "'").replace(/-/g, ' ');
  const raw = t.split(/\s+/).filter(Boolean);
  const out = [];
  let neg = false;
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (NEGATORS.has(w)) { neg = true; continue; }
    // single letters / digits (spelling) and spoken numbers
    if (/^[a-z0-9]$/.test(w) || isNumWord(w) || /^\d+$/.test(w)) {
      if (/^[a-z]$/.test(w)) {
        const run = [w];
        let k = i + 1;
        // "f as in frank": the helper word is not part of the email
        const skipHelper = () => { if (raw[k] === 'as' && raw[k + 1] === 'in' && raw[k + 2]) k += 3; else if (raw[k] === 'for' && raw[k + 1] && !/^[a-z]$/.test(raw[k + 1])) k += 2; };
        skipHelper();
        while (k < raw.length && /^[a-z]$/.test(raw[k])) { run.push(raw[k]); k++; skipHelper(); }
        i = k - 1;
        if (run.length >= 2) { out.push({ text: run.join(''), spelled: true, neg }); neg = false; }
        // a lone letter is only meaningful inside "z is an f" patterns, handled separately
        continue;
      }
      // digits and number words
      const digits = [];
      let k = i;
      while (k < raw.length && (/^\d+$/.test(raw[k]) || isNumWord(raw[k]) || (raw[k] === 'and' && isNumWord(raw[k + 1] || '') && digits.length))) {
        digits.push(raw[k]); k++;
      }
      i = k - 1;
      const words = digits.filter((x) => !/^\d+$/.test(x));
      const text = words.length ? parseNumberRun(digits.map((x) => x)) : digits.join('');
      const joined = digits.map((x) => (/^\d+$/.test(x) ? x : null));
      const final = joined.every((x) => x !== null) ? joined.join('') : text;
      if (final) { out.push({ text: final, spelled: false, neg }); neg = false; }
      continue;
    }
    if (FILL.has(w) || !/^[a-z0-9']+$/.test(w)) continue;
    const word = w.replace(/'/g, '');
    if (word.length >= 2) { out.push({ text: word, spelled: false, neg }); neg = false; }
  }
  return out;
}

// ---- finding where a piece belongs ------------------------------------------------

function bestWindow(local, c) {
  let best = null;
  for (let len = Math.max(2, c.length - 1); len <= c.length + 1; len++) {
    for (let s = 0; s + len <= local.length; s++) {
      const d = editDistance(local.slice(s, s + len), c);
      if (!best || d < best.d || (d === best.d && len === c.length && best.len !== c.length)) best = { s, e: s + len, d, len };
    }
  }
  return best;
}
function maxDistance(c) {
  if (/^\d+$/.test(c)) return c.length >= 2 ? 1 : 0;
  return c.length >= 6 ? 2 : c.length >= 4 ? 1 : 0;
}

function replaceRange(d, s, e, text, override) {
  const range = d.local.slice(s, e);
  const anyLocked = range.some((x) => x.l);
  if (anyLocked && !override) return false;
  if (text.length === e - s) {
    for (let i = 0; i < text.length; i++) {
      const cell = d.local[s + i];
      if (cell.l && !override) continue;
      d.local[s + i] = { c: text[i], l: true };
    }
  } else {
    d.local.splice(s, e - s, ...[...text].map((c) => ({ c, l: true })));
  }
  return true;
}

// ---- letter / number patterns: "the z is an f", "f not z", "8 should be 2" -------

function letterPatches(d, u) {
  let text = u.toLowerCase();
  let changed = false;
  const apply = (oldC, newC) => {
    const local = draftLocal(d);
    let idx = -1;
    if (d.target) idx = [...local].findIndex((c, i) => i >= d.target.s && i < d.target.e && c === oldC);
    if (idx < 0) idx = d.local.findIndex((x) => x.c === oldC && !x.l);
    if (idx < 0) idx = d.local.findIndex((x) => x.c === oldC); // deliberate: allowed to unlock
    if (idx >= 0) { d.local[idx] = { c: newC, l: true }; changed = true; }
  };
  text = text.replace(/\b([a-z])\s*,?\s*(?:not|instead of|rather than)\s+(?:an?\s+)?([a-z])\b/g, (m, n, o) => { apply(o, n); return ' '; });
  text = text.replace(/\b(?:the\s+)?(?:letter\s+)?([a-z0-9])\s+(?:is|was|should be|needs to be|has to be|must be)\s+(?:an?\s+)?([a-z0-9])\b/g, (m, o, n) => { apply(o, n); return ' '; });
  return { text, changed };
}

// ---- main entry --------------------------------------------------------------------

/** Apply one spoken correction to the draft. Returns { changed, needs } ("needs" = which range still needs a replacement). */
export function applyCorrection(draft, utterance) {
  const before = JSON.stringify(draft.local);
  let u = String(utterance || '');

  // dots only move when asked
  if (/\b(no|remove|without|delete|take out|get rid of|drop)\b[^.?!]{0,30}\bdots?\b/i.test(u)) {
    draft.local = draft.local.filter((x) => x.c !== '.');
  }
  const dotAt = u.toLowerCase().match(/\bdot\s+(?:between|after)\s+([a-z0-9]+)(?:\s+and\s+([a-z0-9]+))?/);
  if (dotAt) {
    const w = bestWindow(draftLocal(draft), dotAt[1]);
    if (w && w.d <= 1) draft.local.splice(w.e, 0, { c: '.', l: true });
  }

  u = u.replace(/([a-z0-9']{2,})\s+(?:is|was)\s+(?:wrong|incorrect|not right|not correct|off)\b/gi, 'not $1')
    .replace(/([a-z0-9']{2,})\s+(?:isn't|is not)\s+(?:right|correct)\b/gi, 'not $1');

  const lp = letterPatches(draft, u);
  u = lp.text;

  let chunks = chunksOf(u);
  // A long ramble is chatter, not a correction: loose words in it must not rewrite the address.
  // Digits, letter-by-letter spelling and anything said back exactly still count.
  const looseWords = chunks.filter((c) => !c.spelled && !/^\d+$/.test(c.text));
  if (looseWords.length > 3) chunks = chunks.filter((c) => c.spelled || /^\d+$/.test(c.text) || c.neg || bestWindow(draftLocal(draft), c.text)?.d === 0);
  const hasNeg = /\b(not|wrong|incorrect|actually|instead|rather)\b/i.test(utterance);
  let wrong = null;

  for (const ch of chunks) {
    const local = draftLocal(draft);
    const w = bestWindow(local, ch.text);
    const tol = maxDistance(ch.text);
    const near = w && w.d <= tol;
    if (ch.neg) {
      if (w && w.d === 0) { // only a part that is really there can be called wrong
        for (let i = w.s; i < w.e; i++) draft.local[i].l = false;
        wrong = { s: w.s, e: w.e };
      }
      continue;
    }
    // A part was just called wrong: whatever the caller says next (unless it re-confirms a different, exact part) replaces it.
    if (wrong && (ch.spelled || ch.text.length >= 2)) {
      const confirmsElsewhere = w && w.d === 0 && !(w.s < wrong.e && w.e > wrong.s);
      if (!confirmsElsewhere) {
        replaceRange(draft, wrong.s, wrong.e, ch.text, true);
        wrong = null;
        draft.target = null;
        continue;
      }
    }
    if (near && w.d === 0 && ch.text.length >= 2) {
      for (let i = w.s; i < w.e; i++) draft.local[i].l = true; // said back to us exactly: that part is right
      if (wrong && wrong.s === w.s) wrong = null;
      continue;
    }
    const override = ch.spelled || hasNeg || (wrong && w && w.s < wrong.e && w.e > wrong.s);
    if (near) {
      if (!replaceRange(draft, w.s, w.e, ch.text, override)) draft.conflicts += 1;
      else if (wrong) wrong = null;
      continue;
    }
    // nothing close: if a part was just called wrong (or we asked for it), this is its replacement
    const slot = wrong || draft.target;
    if (slot && (ch.spelled || ch.text.length >= 2)) {
      replaceRange(draft, slot.s, slot.e, ch.text, true);
      wrong = null;
      draft.target = null;
    }
  }
  draft.target = wrong;
  return { changed: before !== JSON.stringify(draft.local) || lp.changed, needs: !!wrong };
}

// ---- the caller said the whole address again ---------------------------------------

function align(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, (_, i) => [i, ...Array(m).fill(0)]);
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { ops.push([a[i - 1] === b[j - 1] ? 'match' : 'sub', i - 1, j - 1]); i--; j--; }
    else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { ops.push(['del', i - 1, -1]); i--; }
    else { ops.push(['ins', -1, j - 1]); j--; }
  }
  return ops.reverse();
}

/**
 * Merge a freshly heard full address into the draft. Loose speech-to-text can't overwrite locked
 * characters; spelling it out letter by letter ("deliberate"), or insisting twice, can.
 */
export function mergeRestatement(draft, email, { deliberate = false } = {}) {
  const [newLocal, newDomain] = String(email).split('@');
  const before = draftEmail(draft);
  if (!draft.domainLocked || deliberate) draft.domain = newDomain;
  const anyLocked = draft.local.some((x) => x.l);
  if (!anyLocked || deliberate || draft.conflicts >= 1 && draftLocal(draft) !== newLocal && draft.insisted === newLocal) {
    draft.local = [...newLocal].map((c) => ({ c, l: false }));
    draft.conflicts = 0; draft.insisted = null;
    return { changed: before !== draftEmail(draft), conflict: false };
  }
  const H = draft.local;
  const ops = align(H.map((x) => x.c).join(''), newLocal);
  const merged = [];
  let conflict = false;
  ops.forEach(([op, hi, ni], k) => {
    if (op === 'match') merged.push(H[hi]);
    else if (op === 'sub') { if (H[hi].l) { merged.push(H[hi]); conflict = true; } else merged.push({ c: newLocal[ni], l: false }); }
    else if (op === 'del') { if (H[hi].l) { merged.push(H[hi]); conflict = true; } }
    else { const prev = merged[merged.length - 1]; const next = ops.slice(k + 1).find(([o]) => o !== 'ins'); const nextLocked = next && next[1] >= 0 && H[next[1]]?.l; if (prev?.l && nextLocked) conflict = true; else merged.push({ c: newLocal[ni], l: false }); }
  });
  draft.local = merged;
  if (conflict) { draft.conflicts += 1; draft.insisted = newLocal; } else { draft.conflicts = 0; draft.insisted = null; }
  return { changed: before !== draftEmail(draft), conflict };
}
