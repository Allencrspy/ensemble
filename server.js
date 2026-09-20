/*
 * Ensemble — synchronized multi-device audio playback.
 * Zero-dependency Node server: static files + track upload/distribution +
 * a minimal RFC6455 WebSocket implementation for room coordination.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 200 * 1024 * 1024; // 200 MB

// Monotonic server clock in float milliseconds. Every device syncs to this.
const hrBase = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - hrBase) / 1e6;

const RoomCore = require('./public/room-core.js');

/* ------------------------------------------------------------------ rooms */

/** @type {Map<string, object>} */
const rooms = new Map();

function createRoom() {
  let code;
  do { code = RoomCore.makeCode((n) => crypto.randomInt(n)); } while (rooms.has(code));
  const room = RoomCore.createRoom(code);
  room.conns = new Map();          // deviceId -> Conn
  rooms.set(code, room);
  return room;
}

function ctxFor(room) {
  return {
    now,
    send(id, msg) {
      const c = room.conns.get(id);
      if (c) c.send(msg);
    },
    broadcast(msg, exceptId) {
      const payload = JSON.stringify(msg);
      for (const [id, c] of room.conns) if (id !== exceptId) c.sendRaw(payload);
    },
    drop(id) {
      const c = room.conns.get(id);
      if (c) c.close(1000);
      dropDevice(room, id);
    },
  };
}

function pushRoster(room) {
  ctxFor(room).broadcast({ t: 'roster', room: RoomCore.snapshot(room), serverNow: now() });
}

function dropDevice(room, id) {
  const promoted = RoomCore.leave(room, id);
  room.conns.delete(id);
  if (promoted) ctxFor(room).send(promoted.id, { t: 'promoted' });
  if (room.devices.size === 0) {
    setTimeout(() => {
      if (rooms.get(room.code) === room && room.devices.size === 0) rooms.delete(room.code);
    }, 90_000);
    return;
  }
  pushRoster(room);
}

/* ------------------------------------------------------- websocket (raw) */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.alive = true;
    this.onMessage = () => {};
    this.onClose = () => {};

    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      try { this.drain(); } catch (err) { this.close(1002); }
    });
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());

    this.hb = setInterval(() => {
      if (!this.alive) return this.destroy();
      this.alive = false;
      this.frame(0x9, Buffer.alloc(0));
    }, 25_000);
  }

  drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < off + 2) return; len = b.readUInt16BE(off); off += 2; }
      else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off);
        if (big > 64n * 1024n * 1024n) throw new Error('frame too large');
        len = Number(big); off += 8;
      }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;

      let payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);

      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this.frame(0xA, payload); continue; }
      if (opcode === 0xA) { this.alive = true; continue; }

      if (opcode === 0x0) {
        if (!this.frag) throw new Error('unexpected continuation');
        this.frag = Buffer.concat([this.frag, payload]);
      } else {
        this.frag = payload;
        this.fragOp = opcode;
      }
      if (fin) {
        const data = this.frag; const op = this.fragOp;
        this.frag = null;
        if (op === 0x1) {
          let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { continue; }
          this.alive = true;
          this.onMessage(msg);
        }
      }
    }
  }

  frame(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendRaw(str) { this.frame(0x1, Buffer.from(str, 'utf8')); }
  send(obj) { this.sendRaw(JSON.stringify(obj)); }

  close(code = 1000) {
    if (this.socket.destroyed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    try { this.frame(0x8, p); } catch {}
    this.socket.end();
    this.destroy();
  }

  destroy() {
    clearInterval(this.hb);
    if (!this.socket.destroyed) this.socket.destroy();
    if (!this.closed) { this.closed = true; this.onClose(); }
  }
}

/* --------------------------------------------------------------- routing */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/info') {
    return sendJSON(res, 200, { port: PORT, addresses: lanAddresses(), serverNow: now() });
  }

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const room = rooms.get((url.searchParams.get('room') || '').toUpperCase());
    if (!room) return sendJSON(res, 404, { error: 'room not found' });
    const deviceId = url.searchParams.get('device');
    if (room.hostId !== deviceId) return sendJSON(res, 403, { error: 'only the host can add a track' });

    const chunks = []; let total = 0; let aborted = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_UPLOAD) { aborted = true; sendJSON(res, 413, { error: 'file too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const id = crypto.randomBytes(8).toString('hex');
      RoomCore.setTrack(room, {
        id,
        name: url.searchParams.get('name') || 'Untitled',
        mime: req.headers['content-type'] || 'application/octet-stream',
        size: total,
        data: Buffer.concat(chunks),
        url: `/api/track/${room.code}/${id}`,
      });
      pushRoster(room);
      sendJSON(res, 200, { id, url: room.track.url, size: total });
    });
    return;
  }

  const m = url.pathname.match(/^\/api\/track\/([A-Z0-9]{4})\/([a-f0-9]{16})$/);
  if (m) {
    const room = rooms.get(m[1]);
    if (!room || !room.track || room.track.id !== m[2]) { res.writeHead(404).end(); return; }
    const { data, mime } = room.track;
    const range = req.headers.range;
    if (range) {
      const rm = /bytes=(\d*)-(\d*)/.exec(range);
      const start = rm && rm[1] ? Number(rm[1]) : 0;
      const end = rm && rm[2] ? Math.min(Number(rm[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return; }
      const slice = data.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': mime, 'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
    res.end(data);
    return;
  }

  serveStatic(req, res);
});

/* ------------------------------------------------------- ws room protocol */

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const conn = new Conn(socket);
  let device = null;
  let room = null;

  conn.onClose = () => { if (room && device) dropDevice(room, device.id); };

  conn.onMessage = (msg) => {
    if (msg && msg.t === 'sync' && device) {           // answered first, always cheap
      device.lastSeen = now();
      conn.send({ t: 'sync', c: msg.c, s: now() });
      return;
    }

    if (msg.t === 'join') {
      if (device) return;
      if (msg.create) room = createRoom();
      else {
        room = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!room) {
          conn.send({ t: 'error', code: 'no-room', message: `No session named ${String(msg.code || '—').toUpperCase()}` });
          return;
        }
      }
      const stale = RoomCore.findByKey(room, msg.key);
      if (stale) {                     // same device, opened again: retire the old entry
        const old = room.conns.get(stale.id);
        if (old) { old.send({ t: 'superseded' }); old.close(1000); }
        room.devices.delete(stale.id);
        room.conns.delete(stale.id);
      }
      device = RoomCore.join(room, ctxFor(room), {
        id: crypto.randomBytes(6).toString('hex'),
        key: typeof msg.key === 'string' ? msg.key.slice(0, 40) : null,
        name: msg.name, mode: msg.mode, forceHost: !!msg.create, inherit: stale,
      });
      room.conns.set(device.id, conn);
      conn.send({ t: 'welcome', id: device.id, serverNow: now(), room: RoomCore.snapshot(room) });
      pushRoster(room);
      return;
    }

    if (!device || !room) return;
    if (RoomCore.handle(room, device, msg, ctxFor(room))) pushRoster(room);
  };
});

// Same liveness policy as the peer-to-peer hub, so both transports behave alike.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const id of RoomCore.reap(room, now(), 25000)) {
      const c = room.conns.get(id);
      if (c) c.close(1000);
      dropDevice(room, id);
    }
  }
}, 5000);

server.listen(PORT, () => {
  const addrs = lanAddresses();
  console.log('\n  Ensemble is running\n');
  console.log(`  On this device   http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  On your network  http://${a}:${PORT}`);
  console.log('\n  Open the first link, start a session, then join from other devices\n  on the same Wi-Fi with the 4-character code.\n');
});
