// Email capture for voice calls.
//
// Speech-to-text turns a spelled or spoken email into noisy fragments ("nox fever",
// "2002@Gmail.com", "k n o x"). Asking the language model to stitch that together
// is where letters get lost, so the code does it: it joins every fragment the caller
// says, builds the address, checks it, and speaks the readback itself.
//
// Pure functions only (no I/O) except domainResolves(), which fails open.

const ZW = /[\u200B-\u200D\u2060\uFEFF]/g;

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};
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
      const d = /^\d$/.test(n) ? n : NUMBER_WORDS[n];
      if (d !== undefined) { for (let k = 0; k < rep; k++) out.push({ t: 'D', v: d }); i += 1; continue; }
      if (/^[a-z]$/.test(n)) { for (let k = 0; k < rep; k++) out.push({ t: 'L', v: n }); i += 1; continue; }
    }

    if (SYMBOL_WORDS[w] !== undefined) { out.push({ t: 'S', v: SYMBOL_WORDS[w] }); continue; }
    if (/^\d+$/.test(w)) { for (const ch of w) out.push({ t: 'D', v: ch }); continue; }
    if (NUMBER_WORDS[w] !== undefined) { out.push({ t: 'D', v: NUMBER_WORDS[w] }); continue; }
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
  if (runStart >= 0) use = tokens.slice(runStart).filter((x) => x.t !== 'W');
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

/** Parse everything the caller has said so far into an address. */
export function parseSpokenEmail(text) {
  const tokens = tokenise(text);
  const atIdx = tokens.map((x) => (x.t === 'S' && x.v === '@' ? 1 : 0)).lastIndexOf(1);
  if (atIdx < 0) {
    return { complete: false, hasAt: false, local: buildLocal(tokens.filter((x) => x.t !== 'S' || x.v !== '@')), domain: '', email: '' };
  }
  const local = buildLocal(tokens.slice(0, atIdx));
  const domain = buildDomain(tokens.slice(atIdx + 1));
  const email = local && domain ? `${local}@${domain}` : '';
  const complete = !!email && EMAIL_RE.test(email);
  return { complete, hasAt: true, local, domain, email: complete ? email : '' };
}

// ---- when to run ----------------------------------------------------------------

/** Did the agent just ask for an email (and not merely read one back)? */
export function isEmailPrompt(text) {
  const t = String(text || '');
  const mentionsEmail = /\be-?mail\b/i.test(t) || /\bat sign\b/i.test(t);
  if (!mentionsEmail) return false;
  // A read-back or a confirmation question is not a request for the address.
  if (/\b(did i get|is that (right|correct)|am i right|got it right|have it right)\b/i.test(t)) return false;
  if (/\b(right|correct)\b[^a-z]*$/i.test(t.trim())) return false;
  const asks = /\b(spell|best e-?mail|your e-?mail|the e-?mail|what('| i)?s (the|your)|could i (get|have)|can i (get|have)|may i (get|have)|share|give me|go ahead|need)\b/i.test(t);
  return asks && /[?]|\bplease\b|\bslowly\b/i.test(t);
}

export function yesNo(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ');
  if (/^(no|nope|nah|not (right|correct|quite)|wrong|incorrect|that'?s (not|wrong)|it'?s not|it is not)\b/.test(t)) return 'no';
  if (/\b(not correct|isn'?t (right|correct)|is not (right|correct)|wrong)\b/.test(t) && !/^(yes|yeah|yep)/.test(t)) return 'no';
  if (/^(yes|yeah|yep|yup|yea|correct|right|exactly|perfect|sure|ok|okay|uh huh|that'?s (right|correct)|you got it|sounds right)\b/.test(t)) return 'yes';
  return null;
}

// ---- speaking it back -----------------------------------------------------------

const SAY = { '.': 'dot', '-': 'dash', '_': 'underscore', '+': 'plus' };

function spellChars(s) {
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
