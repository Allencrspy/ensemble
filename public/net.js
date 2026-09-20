/* Ensemble — transport.
 *
 * Two ways to run, one protocol (see room-core.js):
 *
 *   LAN mode   — a Node server holds the room. Works with no internet at all.
 *   P2P mode   — no server: the host's tab holds the room and every other
 *                device connects to it over a WebRTC data channel. This is what
 *                runs on GitHub Pages, where there is nothing to run a server on.
 *                A public PeerJS broker is used for the initial handshake only;
 *                audio, control and clock traffic never touch it.
 */
'use strict';

const PEER_PREFIX = 'ensemble1-';
const CHUNK = 64 * 1024;

/* ─────────────────────────────── links ─────────────────────────────────── */

/** Host tab talking to the room it is itself hosting. */
class LocalLink {
  constructor() { this.onMessage = () => {}; this.onClose = () => {}; this.peer = null; }
  send(msg) { queueMicrotask(() => this.inbound && this.inbound(msg)); }   // app → hub
  deliver(msg) { queueMicrotask(() => this.onMessage(msg)); }              // hub → app
  close() {}
}

/** Client talking to a host tab over a WebRTC data channel. */
class PeerLink {
  constructor(conn) {
    this.conn = conn;
    this.onMessage = () => {};
    this.onClose = () => {};
    conn.on('data', (d) => this.onMessage(d));
    conn.on('close', () => this.onClose());
    conn.on('error', () => this.onClose());
  }
  send(msg) { if (this.conn.open) this.conn.send(msg); }
  get buffered() {
    const dc = this.conn.dataChannel;
    return dc ? dc.bufferedAmount : 0;
  }
  close() { try { this.conn.close(); } catch {} }
}

/** Client talking to the Node server. */
class WSLink {
  constructor(url) {
    this.onMessage = () => {};
    this.onClose = () => {};
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { this.onMessage(e.data); return; }
      try { this.onMessage(JSON.parse(e.data)); } catch {}
    };
    this.ws.onclose = () => this.onClose();
  }
  get ready() { return this.ws.readyState === 1; }
  send(msg) { if (this.ready) this.ws.send(JSON.stringify(msg)); }
  sendBinary(buf) { if (this.ready && this.ws.bufferedAmount < 2e6) this.ws.send(buf); }
  close() { try { this.ws.close(); } catch {} }
}

/* ──────────────────────────────── the hub ──────────────────────────────── */

/** Runs inside the host's tab in P2P mode: the room, for everyone else. */
class Hub {
  constructor(code) {
    this.localId = null;             // the device belonging to the tab running this hub
    this.room = RoomCore.createRoom(code);
    this.links = new Map();          // deviceId -> link
    this.base = performance.now();
    this.trackBytes = null;          // ArrayBuffer of the shared track
  }

  now() { return performance.now() - this.base; }

  /** A phone that walks out of range never closes its channel cleanly. */
  startReaper() {
    clearInterval(this._reaper);
    this._reaper = setInterval(() => {
      for (const id of RoomCore.reap(this.room, this.now(), 25000)) {
        if (this.links.has(id)) this.remove(id);
      }
    }, 5000);
  }

  ctx() {
    const self = this;
    return {
      now: () => self.now(),
      send(id, msg) { const l = self.links.get(id); if (l) l.send(msg); },
      broadcast(msg, exceptId) {
        for (const [id, l] of self.links) if (id !== exceptId) l.send(msg);
      },
      drop(id) { self.remove(id); },
    };
  }

  roster() {
    this.ctx().broadcast({ t: 'roster', room: RoomCore.snapshot(this.room), serverNow: this.now() });
  }

  attach(link, opts) {
    let stale = RoomCore.findByKey(this.room, opts.key);
    if (stale && stale.id === this.localId) stale = null;   // the tab running the hub is never superseded
    if (stale) {                       // same device, opened again: retire the old entry
      const old = this.links.get(stale.id);
      if (old) { try { old.send({ t: 'superseded' }); } catch {} }
      this.room.devices.delete(stale.id);
      if (old) { try { old.close(); } catch {} this.links.delete(stale.id); }
    }
    const device = RoomCore.join(this.room, this.ctx(), {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, '').slice(0, 12),
      key: opts.key, name: opts.name, mode: opts.mode,
      forceHost: !!opts.forceHost, inherit: stale,
    });
    this.links.set(device.id, link);
    link.send({ t: 'welcome', id: device.id, serverNow: this.now(), room: RoomCore.snapshot(this.room) });
    this.roster();
    return device;
  }

  remove(id) {
    const link = this.links.get(id);
    if (link) { link.close(); this.links.delete(id); }
    const promoted = RoomCore.leave(this.room, id);
    if (promoted) this.ctx().send(promoted.id, { t: 'promoted' });
    this.roster();
  }

  receive(deviceId, msg) {
    const device = this.room.devices.get(deviceId);
    if (!device || !msg) return;
    if (msg.t === 'fetch') { this.streamTrack(deviceId); return; }
    if (RoomCore.handle(this.room, device, msg, this.ctx())) this.roster();
  }

  setTrack(meta, bytes) {
    this.trackBytes = bytes;
    RoomCore.setTrack(this.room, Object.assign({ url: null }, meta));
    this.roster();
  }

  /** Push the track down one data channel, pacing against the send buffer. */
  async streamTrack(deviceId) {
    const link = this.links.get(deviceId);
    const bytes = this.trackBytes;
    if (!link || !bytes || !this.room.track) return;
    const id = this.room.track.id;
    link.send({ t: 'trackStart', id, bytes: bytes.byteLength });
    for (let off = 0; off < bytes.byteLength; off += CHUNK) {
      if (!this.links.has(deviceId)) return;
      while (link.buffered > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 40));
      link.send(bytes.slice(off, Math.min(off + CHUNK, bytes.byteLength)));
    }
    link.send({ t: 'trackEnd', id });
  }
}

/* ──────────────────────────────── facade ───────────────────────────────── */

const Net = {
  mode: null,          // 'ws' | 'p2p'
  transfer: null,      // in-flight file transfer over the data channel
  link: null,
  hub: null,
  peer: null,
  code: null,
  isHub: false,
  localBytes: null,    // host's own copy of the track in P2P mode
  onMessage: () => {},
  onStatus: () => {},

  /**
   * LAN when a Node server answers, peer-to-peer otherwise (e.g. GitHub Pages).
   * Only a local address is probed — a public host is never running this
   * server, and the probe would just log a 404. Force it with ?mode=ws.
   */
  async detectMode() {
    if (/[?&]mode=p2p/.test(location.search)) return 'p2p';
    if (/[?&]mode=ws/.test(location.search)) return 'ws';
    if (location.protocol === 'file:') return 'p2p';
    const h = location.hostname;
    const localish = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(h) ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.local$/.test(h);
    if (!localish) return 'p2p';
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch('api/info', { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok && (res.headers.get('content-type') || '').includes('json')) return 'ws';
    } catch {}
    return 'p2p';
  },

  async start(opts) {
    this.mode = this.mode || await this.detectMode();
    return this.mode === 'ws' ? this.startWS(opts) : this.startP2P(opts);
  },

  /* ── LAN ── */
  startWS(opts) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const link = new WSLink(`${proto}://${location.host}/ws`);
    this.link = link;
    link.ws.onopen = () => {
      this.onStatus('connected');
      link.send({ t: 'join', create: opts.create, code: opts.code, name: opts.name, mode: opts.mode, key: opts.key });
    };
    link.onMessage = (m) => this.dispatch(m);
    link.onClose = () => this.onStatus('closed');
    return Promise.resolve();
  },

  /* ── peer to peer ── */
  async startP2P(opts) {
    await loadPeerJS();
    return opts.create ? this.hostP2P(opts) : this.joinP2P(opts);
  },

  async hostP2P(opts) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = RoomCore.makeCode();
      const peer = new Peer(PEER_PREFIX + code, { debug: 0 });
      const ok = await new Promise((res) => {
        peer.on('open', () => res(true));
        peer.on('error', (e) => res(e.type === 'unavailable-id' ? false : Promise.reject(e)));
        setTimeout(() => res(false), 12000);
      }).catch((e) => { throw e; });
      if (!ok) { peer.destroy(); continue; }

      this.peer = peer;
      this.code = code;
      this.isHub = true;
      this.hub = new Hub(code);
      this.hub.startReaper();

      // Remote devices arrive here; each gets its own link into the hub.
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          const link = new PeerLink(conn);
          let device = null;
          link.onMessage = (msg) => {
            if (!msg) return;
            if (msg instanceof ArrayBuffer) return;
            if (!device) {
              if (msg.t !== 'join') return;
              device = this.hub.attach(link, { name: msg.name, mode: msg.mode, key: msg.key });
            } else this.hub.receive(device.id, msg);
          };
          link.onClose = () => { if (device) this.hub.remove(device.id); };
        });
      });
      peer.on('error', (e) => this.onStatus('peer-error', e));
      peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });

      // The host's own device talks to its hub in-process.
      const local = new LocalLink();
      local.inbound = (msg) => this.hub.receive(this.localId, msg);
      local.onMessage = (m) => this.dispatch(m);
      this.link = local;
      const device = this.hub.attach({
        send: (m) => local.deliver(m), close: () => {}, get buffered() { return 0; },
      }, { name: opts.name, mode: opts.mode, key: opts.key, forceHost: true });
      this.localId = device.id;
      this.hub.localId = device.id;
      this.onStatus('connected');
      return;
    }
    throw new Error('Could not claim a session code — try again');
  },

  async joinP2P(opts) {
    const code = String(opts.code || '').toUpperCase();
    const peer = new Peer({ debug: 0 });
    this.peer = peer;
    await new Promise((res, rej) => {
      peer.on('open', res);
      peer.on('error', (e) => rej(new Error(e.type === 'network' ? 'Cannot reach the signalling service' : e.type)));
      setTimeout(() => rej(new Error('Signalling timed out')), 12000);
    });

    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'binary' });
    await new Promise((res, rej) => {
      conn.on('open', res);
      peer.on('error', (e) => rej(new Error(
        e.type === 'peer-unavailable' ? `No session named ${code}` : e.type)));
      setTimeout(() => rej(new Error('That session did not answer')), 15000);
    });

    const link = new PeerLink(conn);
    this.link = link;
    this.code = code;
    link.onMessage = (m) => this.dispatch(m);
    link.onClose = () => this.onStatus('closed');
    link.send({ t: 'join', name: opts.name, mode: opts.mode, key: opts.key });
    this.onStatus('connected');
  },

  send(msg) { if (this.link) this.link.send(msg); },

  /** Host only: push a live audio chunk to every other device. */
  broadcastBinary(buf) {
    if (this.isHub && this.hub) {
      for (const [id, l] of this.hub.links) {
        if (id === this.localId) continue;
        try { l.send(buf); } catch {}
      }
      return;
    }
    if (this.link && this.link.sendBinary) this.link.sendBinary(buf);   // LAN: the server relays
  },

  /** One inbound path for every transport: file chunks first, room traffic after. */
  dispatch(m) {
    const binary = m instanceof ArrayBuffer || ArrayBuffer.isView(m);
    if (binary) {
      // Live audio and file chunks share the channel; the magic tells them apart.
      const buf = m instanceof ArrayBuffer ? m : m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength);
      if (buf.byteLength > LIVE_HEADER && new DataView(buf).getUint32(0) === LIVE_MAGIC) {
        Live.enqueue(buf);
        return;
      }
      m = buf;
    }
    const tr = this.transfer;
    if (tr) {
      if (binary) { tr.chunk(m); return; }
      if (m && m.t === 'trackStart') { tr.start(m); return; }
      if (m && m.t === 'trackEnd') { tr.end(m); return; }
    }
    if (binary) return;                                   // a stray chunk after a timeout
    if (m && (m.t === 'trackStart' || m.t === 'trackEnd')) return;
    this.onMessage(m);
  },

  /* ── track distribution ── */

  /** Host side: share a file with the room. */
  async publishTrack(file, onProgress) {
    if (this.mode === 'ws') {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const q = new URLSearchParams({ room: this.code || App.room.code, device: App.id, name: file.name });
        xhr.open('POST', 'api/upload?' + q.toString());
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error('upload failed')));
        xhr.onerror = () => reject(new Error('upload failed'));
        xhr.send(file);
      });
    }
    const bytes = await file.arrayBuffer();
    this.localBytes = bytes;
    onProgress(1);
    this.hub.setTrack({
      id: Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-8),
      name: file.name, mime: file.type || 'audio/*', size: bytes.byteLength,
    }, bytes);
  },

  /** Any device: get the bytes of the current track. */
  async fetchTrack(track, onProgress) {
    // decodeAudioData detaches whatever it is handed, so the hub always lends a copy.
    if (this.isHub && this.localBytes) { onProgress(1); return this.localBytes.slice(0); }

    if (track.url) {                                   // LAN: plain HTTP, resumable and cacheable
      const res = await fetch(track.url);
      if (!res.ok) throw new Error('http ' + res.status);
      const total = Number(res.headers.get('content-length') || track.size || 0);
      const chunks = []; let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        onProgress(total ? got / total : 0);
      }
      return new Blob(chunks).arrayBuffer();
    }

    // P2P: ask the host to push it down the data channel.
    if (this.transfer) throw new Error('already transferring');
    return new Promise((resolve, reject) => {
      const parts = [];
      let expected = Number(track.size) || 0, got = 0;
      const finish = (fn, arg) => { clearTimeout(timer); this.transfer = null; fn(arg); };
      const timer = setTimeout(() => finish(reject, new Error('track transfer timed out')), 180000);

      this.transfer = {
        start: (m) => { expected = m.bytes; parts.length = 0; got = 0; },
        chunk: (m) => {
          const buf = m instanceof ArrayBuffer ? m : m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength);
          parts.push(buf); got += buf.byteLength;
          onProgress(expected ? got / expected : 0);
        },
        end: () => {
          const out = new Uint8Array(got);
          let off = 0;
          for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength; }
          finish(resolve, out.buffer);
        },
      };
      this.send({ t: 'fetch' });
    });
  },
};

function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/peerjs.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the peer-to-peer library'));
    document.head.appendChild(s);
  });
}
