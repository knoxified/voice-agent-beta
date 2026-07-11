// ─── Temporary in-memory session store (replaces Redis) ──
// Use this for local testing on Windows.
// On production/VPS, replace with the Redis version.

const sessions = new Map();
const SESSION_TTL = 60 * 60; // 1 hour in seconds (matches Redis TTL)

// ─── Create session at call start ─────────────────────────
async function initSession(callControlId, data) {
  const key = callControlId;
  sessions.set(key, { ...data, _created: Date.now() });
  console.log(`[Session] Created for ${callControlId}`);
  return data;
}

// ─── Get session by callControlId ─────────────────────────
async function getSession(callControlId) {
  const key = callControlId;
  const session = sessions.get(key);
  if (!session) return null;
  return { ...session }; // Return a copy
}

// ─── Update session (merge, not replace) ──────────────────
async function updateSession(callControlId, updates) {
  const key = callControlId;
  const existing = sessions.get(key);
  if (!existing) return null;

  const updated = { ...existing, ...updates };
  sessions.set(key, updated);
  console.log(`[Session] Updated for ${callControlId}`);
  return updated;
}

// ─── Destroy session at call end ──────────────────────────
async function destroySession(callControlId) {
  const key = callControlId;
  sessions.delete(key);
  console.log(`[Session] Destroyed for ${callControlId}`);
}

// ─── Dummy Redis object to keep rateLimit.js happy ────────
const redis = {
  incr: async () => 1,
  expire: async () => true,
  get: async () => null,
  set: async () => true,
  setex: async () => true,
  del: async () => true
};

module.exports = { initSession, getSession, updateSession, destroySession, redis };