require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');
const path = require('path');

const {
  inboundCallHandler,
  outboundStatusHandler
} = require('./handlers/call');

const {
  browserTokenHandler,
  browserInboundHandler
} = require('./handlers/browser');

const { mediaStreamHandler } = require('./handlers/stream');
const { rateLimiter } = require('./middleware/rateLimit');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimiter);

// ─── Serve browser test page ───────────────────────────────
// Files inside /public are available at /test
// public/index.html -> http://localhost:3000/test/
app.use('/test', express.static(path.join(__dirname, '..', 'public')));

// ─── Health check ──────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    ts: Date.now()
  })
);

// ─── PSTN inbound (Twilio + Telnyx) ────────────────────────
app.post('/voice/inbound', inboundCallHandler);

// ─── Call status callback ──────────────────────────────────
app.post('/voice/status', outboundStatusHandler);

// ─── Browser SDK endpoints ─────────────────────────────────
app.get('/token', browserTokenHandler);
app.post('/voice/browser', browserInboundHandler);

// ─── HTTP + WebSocket server ───────────────────────────────
const server = createServer(app);

const wss = new WebSocket.Server({
  server,
  path: '/voice/stream'
});

wss.on('connection', mediaStreamHandler);

wss.on('error', (err) => {
  console.error('[WSS] Error:', err.message);
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n[Knoxified Voice] Running on port ${PORT}`);
  console.log(`[Knoxified Voice] ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Knoxified Voice] TTS: ${process.env.TTS_PROVIDER || 'cartesia'}`);
  console.log('─────────────────────────────────────────────');
  console.log(' PSTN webhook:    POST /voice/inbound');
  console.log(' Status callback: POST /voice/status');
  console.log(' Browser token:   GET  /token?userId=YOUR_UUID');
  console.log(' Browser TwiML:   POST /voice/browser');
  console.log(' WebSocket:       wss://your-domain/voice/stream');
  console.log(` Test page:       http://localhost:${PORT}/test/`);
  console.log('─────────────────────────────────────────────\n');
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});