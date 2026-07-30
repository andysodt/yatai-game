const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// In-memory room store (mirrors api/room.js logic)
const rooms = new Map();
// Reserved code for the shared, ownerless "street" hangout — auto-created on first join,
// never explicitly created by a client. Excluded from the directory listing.
const PLAZA_CODE = 'PLAZA1';
// Reserved code for the shared, ownerless Pachinko Palace — same auto-create pattern as
// the Plaza, but shown IN the directory as a synthetic always-present entry.
const PACHINKO_CODE = 'PACHIN1';
// Reserved code for the shared, ownerless Beach — same pattern as the Palace.
const BEACH_CODE = 'BEACH1';
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) { if (room.ts < cutoff) rooms.delete(code); }
}, 10 * 60 * 1000);

function emptyRoom(hostName) {
  return { host: hostName, guests: {}, state: null, messages: [], positions: {}, ct: {}, ts: Date.now() };
}

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

function chatHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch(_) {}
    const { message, systemPrompt } = parsed;
    if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing message' })); return; }

    try {
      const r = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:3b',
          messages: [
            { role: 'system', content: systemPrompt || 'You are a customer at a Japanese yatai food stall. Respond in Japanese, keep it short and natural (1-2 sentences).' },
            { role: 'user', content: message },
          ],
          stream: false,
        }),
      });
      const data = await r.json();
      const reply = data?.message?.content || '…';
      res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function roomHandler(req, res, parsedUrl) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && parsedUrl.query.list === '1') {
    const list = [];
    for (const [code, room] of rooms) {
      if (code === PLAZA_CODE || code === PACHINKO_CODE || code === BEACH_CODE) continue;
      list.push({
        code, hostName: room.host, type: 'yatai',
        isOpen: !!(room.state && room.state.isOpen),
        guestCount: Object.keys(room.guests).length,
      });
    }
    // Synthetic, always-present entries — these auto-create lazily on first join
    // (like the Plaza), so they may not exist in `rooms` yet.
    const pachinko = rooms.get(PACHINKO_CODE);
    list.push({
      code: PACHINKO_CODE, hostName: 'Pachinko Palace', type: 'pachinko',
      isOpen: true, guestCount: pachinko ? Object.keys(pachinko.guests).length : 0,
    });
    const beach = rooms.get(BEACH_CODE);
    list.push({
      code: BEACH_CODE, hostName: 'Beach', type: 'beach',
      isOpen: true, guestCount: beach ? Object.keys(beach.guests).length : 0,
    });
    res.end(JSON.stringify({ ok: true, rooms: list })); return;
  }

  const code = ((parsedUrl.query.code || '') + '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'no code' })); return; }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch(_) {}
      const { type, name, guestId, data, xFrac, facing, moving } = parsed;

      if (type === 'create') {
        rooms.set(code, emptyRoom(name || 'Host'));
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (!rooms.has(code)) {
        // The Plaza and Palace are shared, ownerless spaces — auto-create on first join
        // rather than requiring some client to explicitly POST type:'create' for them.
        if (type === 'join' && code === PLAZA_CODE) rooms.set(code, emptyRoom('Street'));
        else if (type === 'join' && code === PACHINKO_CODE) rooms.set(code, emptyRoom('Pachinko Palace'));
        else if (type === 'join' && code === BEACH_CODE) rooms.set(code, emptyRoom('Beach'));
        else { res.end(JSON.stringify({ ok: false, error: 'room not found' })); return; }
      }
      const room = rooms.get(code);
      room.ts = Date.now();

      if (type === 'join') {
        const gid = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
        room.guests[gid] = { name: name || 'Guest', guestId: gid };
        room.messages.push({ type: 'join', guestId: gid, name: name || 'Guest', ts: room.ts });
        res.end(JSON.stringify({ ok: true, guestId: gid })); return;
      }
      if (type === 'state') { room.state = data; res.end(JSON.stringify({ ok: true })); return; }
      if (type === 'pos') {
        if (guestId) {
          room.positions[guestId] = {
            xFrac: typeof xFrac === 'number' ? Math.min(1, Math.max(0, xFrac)) : 0.5,
            facing: facing === 'left' ? 'left' : 'right',
            moving: !!moving,
            ts: room.ts,
          };
        }
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (type === 'msg') {
        const msg = { ...(data || {}), guestId: guestId || null, ts: room.ts };
        if (msg.type === 'order') console.log('[SERVER ORDER]', JSON.stringify(msg));
        room.messages.push(msg);
        if (room.messages.length > 120) room.messages = room.messages.slice(-80);
        // Appearance needs to persist like positions do — a message-only relay means anyone
        // who joins after it was sent (i.e. after it ages out of the since-filtered window)
        // never learns an existing peer's ct at all.
        if (guestId && data && data.type === 'ct' && data.ct) room.ct[guestId] = data.ct;
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (type === 'leave') {
        if (guestId) { delete room.guests[guestId]; delete room.positions[guestId]; delete room.ct[guestId]; room.messages.push({ type: 'leave', guestId, ts: room.ts }); }
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
      positions: room.positions || {},
      ct: room.ct || {},
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
  if (parsed.pathname === '/api/chat') return chatHandler(req, res);

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
