const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// In-memory room store (mirrors api/room.js logic)
const rooms = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) { if (room.ts < cutoff) rooms.delete(code); }
}, 10 * 60 * 1000);

// ── LIVE RELOAD ───────────────────────────────
const reloadClients = new Set();

function broadcastReload() {
  for (const res of reloadClients) {
    try { res.write('data: reload\n\n'); } catch(_) {}
  }
}

// Watch all files in the project directory for changes
let reloadTimer = null;
fs.watch(__dirname, { recursive: false }, (event, filename) => {
  if (!filename || filename.startsWith('.')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log(`[reload] ${filename} changed — notifying browsers`);
    broadcastReload();
  }, 120); // debounce rapid saves
});

function roomHandler(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const code = ((parsedUrl.query.code || '') + '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'no code' })); return; }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch(_) {}
      const { type, name, guestId, data } = parsed;

      if (type === 'create') {
        rooms.set(code, { host: name || 'Host', guests: {}, state: null, messages: [], ts: Date.now() });
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (!rooms.has(code)) { res.end(JSON.stringify({ ok: false, error: 'room not found' })); return; }
      const room = rooms.get(code);
      room.ts = Date.now();

      if (type === 'join') {
        const gid = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
        room.guests[gid] = { name: name || 'Guest', guestId: gid };
        room.messages.push({ type: 'join', guestId: gid, name: name || 'Guest', ts: room.ts });
        res.end(JSON.stringify({ ok: true, guestId: gid })); return;
      }
      if (type === 'state') { room.state = data; res.end(JSON.stringify({ ok: true })); return; }
      if (type === 'msg') {
        const msg = { ...(data || {}), guestId: guestId || null, ts: room.ts };
        if (msg.type === 'order') console.log('[SERVER ORDER]', JSON.stringify(msg));
        room.messages.push(msg);
        if (room.messages.length > 120) room.messages = room.messages.slice(-80);
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (type === 'leave') {
        if (guestId) { delete room.guests[guestId]; room.messages.push({ type: 'leave', guestId, ts: room.ts }); }
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (type === 'close') { rooms.delete(code); res.end(JSON.stringify({ ok: true })); return; }
      res.end(JSON.stringify({ ok: false, error: 'unknown type' }));
    });
    return;
  }

  if (req.method === 'GET') {
    if (!rooms.has(code)) { res.end(JSON.stringify({ ok: false, error: 'room not found' })); return; }
    const room = rooms.get(code);
    const since = parseInt(parsedUrl.query.since || '0') || 0;
    res.end(JSON.stringify({
      ok: true, host: room.host,
      guests: Object.values(room.guests),
      state: room.state,
      messages: room.messages.filter(m => m.ts > since),
      ts: room.ts,
    }));
  }
}

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
               '.mp3':'audio/mpeg', '.mp4':'video/mp4', '.jpg':'image/jpeg', '.png':'image/png' };

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Live-reload SSE endpoint
  if (parsed.pathname === '/api/livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: connected\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (parsed.pathname === '/api/room') return roomHandler(req, res, parsed);

  // Static file server
  let filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(8080, () => console.log('Dev server running at http://localhost:8080'));
