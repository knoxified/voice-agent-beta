// Email capture for voice calls.
//
// Speech-to-text turns a spelled or spoken email into noisy fragments ("nox fever",
// "2002@Gmail.com", "k n o x"). Asking the language model to stitch that together
// is where letters get lost, so the code does it: it joins every fragment the caller
// says, builds the address, checks it, and speaks the readback itself.
//
// Pure functions only (no I/O) except domainResolves(), which fails open.

const ZW = /[\u200B-\u200D\u2060\uFEFF]/g;

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export const isNumWord = (w) => w in UNITS || w in TEENS || w in TENS || w === 'hundred' || w === 'thousand';

/**
 * Turn a run of spoken number words into digits, the way people say numbers in emails:
 * "two thousand and two" -> 2002, "twenty twenty four" -> 2024, "two zero zero two" -> 2002.
 * Never leaves letters inside a number.
 */
export function parseNumberRun(words) {
  const w = words.filter((x) => x !== 'and');
  if (!w.length) return '';
  if (w.some((x) => x === 'hundred' || x === 'thousand')) {
    let total = 0, cur = 0;
    for (const x of w) {
      if (x in UNITS) cur += UNITS[x];
      else if (x in TEENS) cur += TEENS[x];
      else if (x in TENS) cur += TENS[x];
      else if (x === 'hundred') cur = (cur || 1) * 100;
      else if (x === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
    }
    return String(total + cur);
  }
  if (w.every((x) => x in UNITS)) return w.map((x) => UNITS[x]).join('');
  // Year-style groups: "twenty twenty two", "nineteen ninety nine", "twenty five".
  const groups = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] in TEENS) groups.push(TEENS[w[i]]);
    else if (w[i] in TENS) {
      let v = TENS[w[i]];
      if (w[i + 1] in UNITS && UNITS[w[i + 1]] > 0) { v += UNITS[w[i + 1]]; i++; }
      groups.push(v);
    } else groups.push(UNITS[w[i]]);
  }
  return groups.map((g, i) => (i > 0 && g < 10 ? `0${g}` : String(g))).join('');
}

// STT sometimes glues a spoken tail onto digits: "2000andtwo" -> "2002".
function fixGluedNumbers(local) {
  return local.replace(/(\d+)and(one|two|three|four|five|six|seven|eight|nine)(?![a-z])/g, (m, d, w) => (Number(d) % 10 === 0 ? String(Number(d) + UNITS[w]) : m));
}

const SYMBOL_WORDS = {
  at: '@', dot: '.', period: '.', point: '.', dash: '-', hyphen: '-', minus: '-',
  underscore: '_', plus: '+',
};
// Words that surround an email but are not part of it.
const FILLER = new Set([
  'okay', 'ok', 'yes', 'yeah', 'yep', 'sure', 'um', 'uh', 'so', 'well', 'my', 'email', 'e-mail',
  'address', 'is', 'its', "it's", 'it', 'the', 'that', "that's", 'thats', 'like', 'as', 'in', 'for',
  'and', 'then', 'no', 'not', 'sorry', 'please', 'thank', 'thanks', 'you', 'i', 'am', 'its', 'then',
  'name', 'first', 'part', 'before', 'after', 'sign', 'symbol', 'capital', 'small', 'letter', 'letters',
]);
// "F as in Foxtrot" style helpers.
const NATO = {
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', foxtrot: 'f', golf: 'g',
  hotel: 'h', india: 'i', juliet: 'j', juliett: 'j', kilo: 'k', lima: 'l', mike: 'm', november: 'n',
  oscar: 'o', papa: 'p', quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u', victor: 'v',
  whiskey: 'w', xray: 'x', 'x-ray': 'x', yankee: 'y', zulu: 'z',
};
const COMMON_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com', 'aol.com',
  'proton.me', 'protonmail.com', 'yahoo.co.uk', 'me.com', 'msn.com',
]);
const TLD_WORDS = new Set(['com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'ng', 'uk', 'me', 'info', 'biz', 'app', 'dev', 'ai']);

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export function stripInvisible(s) {
  return String(s || '').replace(ZW, '');
}

// ---- tokenising ----------------------------------------------------------------

function tokenise(text) {
  let s = stripInvisible(text).toLowerCase();
  s = s.replace(/@/g, ' at ');
  // A dot / dash / underscore glued between characters is part of the address.
  s = s.replace(/(?<=[a-z0-9])\.(?=[a-z0-9])/g, ' dot ');
  s = s.replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, ' dash ');
  s = s.replace(/_/g, ' underscore ');
  s = s.replace(/\+/g, ' plus ');
  // Everything else (sentence punctuation) is just a separator.
  s = s.replace(/[.,!?;:"“”()\[\]]+/g, ' ').replace(/['’]/g, "'");
  const raw = s.split(/\s+/).filter(Boolean);

  const out = []; // {t:'L'|'D'|'S'|'W', v}
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];

    // "double u" is the letter W, but "double 0" / "double zero" repeats the next digit.
    if ((w === 'double' || w === 'triple') && raw[i + 1]) {
      const n = raw[i + 1];
      if (n === 'u' || n === 'you') { out.push({ t: 'L', v: 'w' }); i += 1; continue; }
      const rep = w === 'double' ? 2 : 3;
      const d = /^\d$/.test(n) ? n : (n in UNITS ? String(UNITS[n]) : undefined);
      if (d !== undefined) { for (let k = 0; k < rep; k++) out.push({ t: 'D', v: d }); i += 1; continue; }
      if (/^[a-z]$/.test(n)) { for (let k = 0; k < rep; k++) out.push({ t: 'L', v: n }); i += 1; continue; }
    }

    if (SYMBOL_WORDS[w] !== undefined) { out.push({ t: 'S', v: SYMBOL_WORDS[w] }); continue; }
    if (/^\d+$/.test(w)) { for (const ch of w) out.push({ t: 'D', v: ch }); continue; }
    if (isNumWord(w)) {
      // Gather the whole spoken number ("two thousand and two") and turn it into digits.
      const run = [w];
      let k = i + 1;
      while (k < raw.length && (isNumWord(raw[k]) || (raw[k] === 'and' && run.some((x) => x === 'hundred' || x === 'thousand') && isNumWord(raw[k + 1] || '')))) { run.push(raw[k]); k++; }
      for (const ch of parseNumberRun(run)) out.push({ t: 'D', v: ch });
      i = k - 1;
      continue;
    }
    if (/^[a-z]$/.test(w)) {
      // "f as in foxtrot" / "f for frank": the letter stands, the helper word is dropped.
      out.push({ t: 'L', v: w });
      if (raw[i + 1] === 'as' && raw[i + 2] === 'in' && raw[i + 3]) i += 3;
      else if (raw[i + 1] === 'for' && raw[i + 2]) i += 2;
      continue;
    }
    if (FILLER.has(w)) continue;
    // A real word ("knox", "gmail"): keep its letters, but remember it was a word, not spelled.
    if (/^[a-z0-9]+$/.test(w)) { out.push({ t: 'W', v: w }); continue; }
  }
  return out;
}

// ---- assembling ----------------------------------------------------------------

function buildLocal(tokens) {
  // When the caller spelled letters out, trust the spelling and drop loose guessed words
  // that came before it ("Knox, like k n o x ..."). Keep everything from the first run on.
  let runStart = -1;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].t === 'L' && tokens[i + 1].t === 'L' && tokens[i + 2].t === 'L') { runStart = i; break; }
  }
  let use = tokens;
  if (runStart >= 0) {
    // Keep words spoken after the spelling ("k n o x favour 2002"), but drop a word that merely repeats the spelled letters.
    let j = runStart;
    while (j < tokens.length && tokens[j].t === 'L') j++;
    const spelled = tokens.slice(runStart, j).map((x) => x.v).join('');
    use = tokens.slice(runStart).filter((x) => !(x.t === 'W' && x.v === spelled));
  }
  let local = use.map((x) => x.v).join('');
  // The caller said it twice in a row: collapse "knoxknox" to "knox".
  const half = local.length / 2;
  if (Number.isInteger(half) && half >= 3 && local.slice(0, half) === local.slice(half)) local = local.slice(0, half);
  return local.replace(/^[.\-_+]+|[.\-_+]+$/g, '');
}

function buildDomain(tokens) {
  let d = tokens.map((x) => x.v).join('');
  d = d.replace(/\.{2,}/g, '.').replace(/^[.\-]+|[.\-]+$/g, '');
  // "gmail com" with the dot dropped by speech-to-text.
  if (d && !d.includes('.')) {
    for (const tld of TLD_WORDS) {
      if (d.length > tld.length + 1 && d.endsWith(tld)) { d = `${d.slice(0, -tld.length)}.${tld}`; break; }
    }
  }
  // Common provider typos from speech-to-text.
  d = d.replace(/^(g-?mail|gee-?mail|gmale|jmail)\./, 'gmail.').replace(/^(yahoo|yaho|yahu)\./, 'yahoo.')
    .replace(/^(hot-?mail)\./, 'hotmail.').replace(/^(out-?look)\./, 'outlook.');
  return d;
}

// Deepgram often hands us a finished address ("knoxfavour2002@Gmail.com") in one piece.
// When the caller's latest sentence contains one, that is the most trustworthy thing we have:
// no stitching, no leftover words from "it's an email and I wanted to use ...".
const INLINE_EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
export function findEmailInText(text) {
  const t = stripInvisible(text).replace(/\s*@\s*/g, '@');
  const all = t.match(INLINE_EMAIL);
  if (!all || !all.length) return '';
  let [local, domain] = all[all.length - 1].toLowerCase().replace(/^\.+/, '').split('@');
  local = fixGluedNumbers(local);
  // Speech-to-text sprinkles dots into names ("knox.favour"). A dot only stays if the caller actually said "dot".
  if (!/\bdots?\b/i.test(t)) local = local.replace(/\./g, '');
  local = local.replace(/^[.\-_+]+|[.\-_+]+$/g, '');
  const e = `${local}@${domain}`;
  return local && EMAIL_RE.test(e) ? e : '';
}

/** "remove the dots", "there's no dots in the middle": the caller wants dots out of the name part. */
export function wantsDotsRemoved(text) {
  return /\b(no|remove|without|delete|take out|get rid of|drop)\b[^.?!]{0,30}\bdots?\b/i.test(String(text || ''));
}
export function stripLocalDots(email) {
  const [local, domain] = String(email).split('@');
  return local && domain ? `${local.replace(/\./g, '')}@${domain}` : email;
}

/** "Say it again", "repeat that", "spell the email out again". */
export function asksRepeat(text) {
  return /\b(say|read|repeat|spell)\b[^.?!]{0,18}\b(it|that|this|e-?mail)\b[^.?!]{0,12}\b(again|back|out)\b|\bsay (it|that) again\b|\bonce more\b|\bcome again\b|\brepeat (it|that)\b/i.test(String(text || ''));
}

/** "What was the email again?" once we already hold a confirmed one. */
export function asksForEmailAgain(text) {
  return /\b(what|which)\b[^.?!]{0,30}\be-?mail\b|\b(repeat|read|say|spell)\b[^.?!]{0,25}\be-?mail\b[^.?!]{0,20}\b(again|back)\b|\be-?mail\b[^.?!]{0,15}\bagain\b/i.test(String(text || ''));
}

/** Parse everything the caller has said so far into an address. */
export function parseSpokenEmail(text) {
  const tokens = tokenise(text);
  const atIdx = tokens.map((x) => (x.t === 'S' && x.v === '@' ? 1 : 0)).lastIndexOf(1);
  const spelled = tokens.some((x, i) => x.t === 'L' && tokens[i + 1]?.t === 'L' && tokens[i + 2]?.t === 'L');
  if (atIdx < 0) {
    return { spelled, complete: false, hasAt: false, local: buildLocal(tokens.filter((x) => x.t !== 'S' || x.v !== '@')), domain: '', email: '' };
  }
  const local = buildLocal(tokens.slice(0, atIdx));
  const domain = buildDomain(tokens.slice(atIdx + 1));
  const email = local && domain ? `${local}@${domain}` : '';
  const complete = !!email && EMAIL_RE.test(email);
  return { spelled, complete, hasAt: true, local, domain, email: complete ? email : '' };
}

// ---- when to run ----------------------------------------------------------------

/** Did the agent just ask for an email (and not merely read one back)? */
export function isEmailPrompt(text) {
  const t = String(text || '');
  if (t.includes('@')) return false; // that is a read-back, not a request
  // Judge each sentence on its own: "how long have you waited?" next to a mention of email is not an email request.
  const sentences = t.match(/[^.!?]+[.!?]*/g) || [t];
  return sentences.some((sent) => {
    if (!/\be-?mail\b|\bat sign\b/i.test(sent)) return false;
    if (/\b(did i get|is that (right|correct)|am i right|got it right|have it right)\b/i.test(sent)) return false;
    if (/\b(right|correct)\b[^a-z]*$/i.test(sent.trim())) return false;
    const asks = /\b(spell|best e-?mail|your e-?mail|the e-?mail|what('| i)?s (the|your)|could i (get|have)|can i (get|have)|may i (get|have)|share|give me|go ahead|need)\b/i.test(sent);
    return asks && /[?]|\bplease\b|\bslowly\b/i.test(sent);
  });
}

export function yesNo(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "you got it right BUT remove the dots" is a correction, not a yes.
  if (/\b(but|except|however|remove|change|without|instead|should be|supposed to|not|wrong|incorrect|dots?)\b/.test(t) && !/^(no|nope|nah)\b/.test(t)) return null;
  if (/^(no|nope|nah|not (right|correct|quite)|wrong|incorrect|that'?s (not|wrong)|it'?s not|it is not)\b/.test(t)) return 'no';
  // A real yes is short. A long sentence that merely starts with "yes" is probably more instructions.
  if (t.split(' ').length <= 7 && /^(yes|yeah|yep|yup|yea|correct|right|exactly|perfect|sure|ok|okay|uh huh|that'?s (right|correct)|you got it|sounds right|it works)\b/.test(t)) return 'yes';
  return null;
}

// ---- speaking it back -----------------------------------------------------------

const SAY = { '.': 'dot', '-': 'dash', '_': 'underscore', '+': 'plus' };

export function spellChars(s) {
  return s.split('').map((c) => SAY[c] || c.toUpperCase()).join(', ');
}

/** Text for the voice: letters one by one so nothing is slurred into a word. */
export function spokenReadback(email) {
  const [local, domain] = String(email).split('@');
  if (!local || !domain) return '';
  let dom;
  if (COMMON_DOMAINS.has(domain)) {
    dom = domain.replace(/\./g, ' dot ');
  } else {
    const parts = domain.split('.');
    const tld = parts.pop();
    dom = `${spellChars(parts.join('.'))}, dot ${tld}`;
  }
  return `${spellChars(local)}, at, ${dom}`;
}

/** "gmail dot com" for common providers, letter by letter for anything else. */
export function spokenDomain(domain) {
  const d = String(domain || '');
  if (COMMON_DOMAINS.has(d)) return d.replace(/\./g, ' dot ');
  const parts = d.split('.');
  const tld = parts.pop();
  return `${spellChars(parts.join('.'))}, dot ${tld}`;
}

/** The caller said just the part after the at sign: "gmail dot com", "k n o x i f i e d dot org". */
export function parseDomainOnly(text) {
  const t = String(text || '');
  const inline = findEmailInText(t.includes('@') ? t : `x@${t.replace(/\s+/g, '')}`);
  if (inline && t.includes('@')) return inline.split('@')[1];
  const p = parseSpokenEmail(`x at ${t}`);
  return p.complete ? p.domain : '';
}

// ---- checks --------------------------------------------------------------------

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}
export const editDistance = lev;

const domainCache = new Map();

/**
 * Does the domain exist (MX or A record)? Uses Cloudflare DNS-over-HTTPS.
 * Fails open: on any network trouble we say "yes" so a DNS hiccup never blocks a caller.
 */
export async function domainResolves(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d || !d.includes('.')) return false;
  if (COMMON_DOMAINS.has(d)) return true;
  if (domainCache.has(d)) return domainCache.get(d);
  const ask = async (type) => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`doh ${res.status}`);
    return res.json();
  };
  try {
    const mx = await ask('MX');
    let ok = Array.isArray(mx.Answer) && mx.Answer.length > 0;
    if (!ok && mx.Status === 0) {
      const a = await ask('A');
      ok = Array.isArray(a.Answer) && a.Answer.length > 0;
    }
    if (mx.Status === 3) ok = false; // NXDOMAIN: definitely not real
    domainCache.set(d, ok);
    return ok;
  } catch {
    return true;
  }
}

export { EMAIL_RE as EMAIL_PATTERN };
