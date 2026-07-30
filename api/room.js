// In-memory room relay — persists within a warm Vercel function instance
const rooms = new Map();
// Reserved code for the shared, ownerless "street" hangout — auto-created on first join,
// never explicitly created by a client. Excluded from the directory listing.
const PLAZA_CODE = 'PLAZA1';
// Reserved code for the shared, ownerless Pachinko Palace — same auto-create pattern as
// the Plaza, but shown IN the directory as a synthetic always-present entry.
const PACHINKO_CODE = 'PACHIN1';
// Reserved code for the shared, ownerless Beach — same pattern as the Palace.
const BEACH_CODE = 'BEACH1';

// Prune rooms older than 3 hours
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.ts < cutoff) rooms.delete(code);
  }
}, 10 * 60 * 1000);

function emptyRoom(hostName) {
  return { host: hostName, guests: {}, state: null, messages: [], positions: {}, ct: {}, ts: Date.now() };
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query.list === '1') {
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
    return res.json({ ok: true, rooms: list });
  }

  const code = ((req.query.code || '') + '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return res.status(400).json({ ok: false, error: 'no code' });

  if (req.method === 'POST') {
    const { type, name, guestId, data, xFrac, facing, moving } = req.body || {};

    if (type === 'create') {
      rooms.set(code, emptyRoom(name || 'Host'));
      return res.json({ ok: true });
    }

    if (!rooms.has(code)) {
      // The Plaza and Palace are shared, ownerless spaces — auto-create on first join
      // rather than requiring some client to explicitly POST type:'create' for them.
      if (type === 'join' && code === PLAZA_CODE) rooms.set(code, emptyRoom('Street'));
      else if (type === 'join' && code === PACHINKO_CODE) rooms.set(code, emptyRoom('Pachinko Palace'));
      else if (type === 'join' && code === BEACH_CODE) rooms.set(code, emptyRoom('Beach'));
      else return res.json({ ok: false, error: 'room not found' });
    }
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
    if (type === 'pos') {
      if (guestId) {
        room.positions[guestId] = {
          xFrac: typeof xFrac === 'number' ? Math.min(1, Math.max(0, xFrac)) : 0.5,
          facing: facing === 'left' ? 'left' : 'right',
          moving: !!moving,
          ts: room.ts,
        };
      }
      return res.json({ ok: true });
    }
    if (type === 'msg') {
      room.messages.push({ ...(data || {}), guestId: guestId || null, ts: room.ts });
      if (room.messages.length > 120) room.messages = room.messages.slice(-80);
      // Appearance needs to persist like positions do — a message-only relay means anyone
      // who joins after it was sent (i.e. after it ages out of the since-filtered window)
      // never learns an existing peer's ct at all.
      if (guestId && data && data.type === 'ct' && data.ct) room.ct[guestId] = data.ct;
      return res.json({ ok: true });
    }
    if (type === 'leave') {
      if (guestId) {
        delete room.guests[guestId];
        delete room.positions[guestId];
        delete room.ct[guestId];
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
      positions: room.positions || {},
      ct: room.ct || {},
      ts: room.ts,
    });
  }

  return res.status(405).end();
}
