const { redis } = require('../services/session');

// ─── Simple Redis-backed rate limiter ─────────────────────
// 100 requests per minute per IP — protects webhook endpoints
async function rateLimiter(req, res, next) {
  // Skip rate limiting for health checks
  if (req.path === '/health') return next();

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const key = `ratelimit:${ip}`;

  try {
    const current = await redis.incr(key);

    if (current === 1) {
      // First request — set 60s expiry
      await redis.expire(key, 60);
    }

    if (current > 100) {
      console.warn(`[RateLimit] IP ${ip} exceeded limit`);
      return res.status(429).json({ error: 'Too many requests' });
    }

    next();
  } catch (err) {
    // If Redis fails, don't block legitimate requests
    console.error('[RateLimit] Redis error:', err.message);
    next();
  }
}

module.exports = { rateLimiter };
