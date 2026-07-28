// In-memory room relay — persists within a warm Vercel function instance
const rooms = new Map();

// Prune rooms older than 3 hours
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.ts < cutoff) rooms.delete(code);
  }
}, 10 * 60 * 1000);

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code = ((req.query.code || '') + '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return res.status(400).json({ ok: false, error: 'no code' });

  if (req.method === 'POST') {
    const { type, name, guestId, data } = req.body || {};

    if (type === 'create') {
      rooms.set(code, { host: name || 'Host', guests: {}, state: null, messages: [], ts: Date.now() });
      return res.json({ ok: true });
    }

    if (!rooms.has(code)) return res.json({ ok: false, error: 'room not found' });
    const room = rooms.get(code);
    room.ts = Date.now();

    if (type === 'join') {
      const gid = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      room.guests[gid] = { name: name || 'Guest', guestId: gid };
      room.messages.push({ type: 'join', guestId: gid, name: name || 'Guest', ts: room.ts });
      return res.json({ ok: true, guestId: gid });
    }
    if (type === 'state') {
      room.state = data;
      return res.json({ ok: true });
    }
    if (type === 'msg') {
      room.messages.push({ ...(data || {}), guestId: guestId || null, ts: room.ts });
      if (room.messages.length > 120) room.messages = room.messages.slice(-80);
      return res.json({ ok: true });
    }
    if (type === 'leave') {
      if (guestId) {
        delete room.guests[guestId];
        room.messages.push({ type: 'leave', guestId, ts: room.ts });
      }
      return res.json({ ok: true });
    }
    if (type === 'close') {
      rooms.delete(code);
      return res.json({ ok: true });
    }
    return res.json({ ok: false, error: 'unknown type' });
  }

  if (req.method === 'GET') {
    if (!rooms.has(code)) return res.json({ ok: false, error: 'room not found' });
    const room = rooms.get(code);
    const since = parseInt(req.query.since || '0') || 0;
    return res.json({
      ok: true,
      host: room.host,
      guests: Object.values(room.guests),
      state: room.state,
      messages: room.messages.filter(m => m.ts > since),
      ts: room.ts,
    });
  }

  return res.status(405).end();
}
