/* Ensemble — the room state machine.
 *
 * Loaded by BOTH the Node server (LAN mode) and the host's browser tab
 * (peer-to-peer mode), so the two transports cannot drift apart: one protocol,
 * one implementation. The caller supplies a context with now(), send() and
 * broadcast(); everything else is pure state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function makeCode(rand) {
    const r = rand || ((n) => Math.floor(Math.random() * n));
    return Array.from({ length: 4 }, () => CODE_ALPHABET[r(CODE_ALPHABET.length)]).join('');
  }

  function createRoom(code) {
    return {
      code,
      hostId: null,
      devices: new Map(),
      track: null,          // { id, name, mime, size, url|null }
      syncBuffer: 700,
      playback: { mode: 'idle', trackId: null, anchorServer: 0, anchorPos: 0, bpm: 100 },
    };
  }

  function createDevice(opts) {
    return {
      id: opts.id,
      key: opts.key || null,
      name: String(opts.name || 'Device').slice(0, 24) || 'Device',
      isHost: !!opts.isHost,
      joinedAt: opts.joinedAt,
      mode: opts.mode || 'stereo',
      volume: 1, muted: false, trim: 0,
      rtt: 0, ready: false, progress: 0, drift: 0, skew: 0,
      calib: null, battery: null, charging: false, net: null, awake: false,
      lat: null, tsrc: null,
      lastSeen: opts.joinedAt,
      pos: null,            // { x, y } metres, from the acoustic room map
    };
  }

  function publicDevice(d) {
    return {
      id: d.id, name: d.name, isHost: d.isHost, joinedAt: d.joinedAt,
      mode: d.mode, volume: d.volume, muted: d.muted, trim: d.trim,
      rtt: d.rtt, ready: d.ready, progress: d.progress, drift: d.drift, skew: d.skew,
      calib: d.calib, battery: d.battery, charging: d.charging, net: d.net,
      awake: d.awake, pos: d.pos, lat: d.lat, tsrc: d.tsrc,
    };
  }

  function snapshot(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      devices: [...room.devices.values()].map(publicDevice),
      syncBuffer: room.syncBuffer,
      track: room.track && {
        id: room.track.id, name: room.track.name,
        size: room.track.size, url: room.track.url || null,
      },
      playback: room.playback,
    };
  }

  /** An earlier entry from the same physical device, if it is still listed. */
  function findByKey(room, key) {
    if (!key) return null;
    for (const d of room.devices.values()) if (d.key === key) return d;
    return null;
  }

  function join(room, ctx, opts) {
    // The transport has usually already unlisted the old entry, so it hands the
    // object over directly; fall back to a lookup when it has not.
    const previous = opts.inherit || findByKey(room, opts.key);
    const device = createDevice({
      id: opts.id,
      key: opts.key,
      name: opts.name,
      mode: opts.mode,
      joinedAt: ctx.now(),
      isHost: room.devices.size === 0 || !!opts.forceHost || !!(previous && previous.isHost),
    });
    // Carry the old entry's setup across, so a reload does not lose this
    // speaker's role, trim or measurements.
    if (previous) {
      device.mode = previous.mode;
      device.volume = previous.volume;
      device.muted = previous.muted;
      device.trim = previous.trim;
      device.calib = previous.calib;
      device.pos = previous.pos;
      device.name = previous.name;
    }
    if (device.isHost) room.hostId = device.id;
    room.devices.set(device.id, device);
    return device;
  }

  /** Remove a device; promotes the longest-connected survivor if the host left. */
  function leave(room, id) {
    const d = room.devices.get(id);
    if (!d) return null;
    room.devices.delete(id);
    if (room.hostId !== id || room.devices.size === 0) return null;
    const next = [...room.devices.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    next.isHost = true;
    room.hostId = next.id;
    return next;
  }

  function setTrack(room, track) {
    room.track = track;
    room.playback = { mode: 'idle', trackId: track ? track.id : null, anchorServer: 0, anchorPos: 0, bpm: room.playback.bpm };
    for (const d of room.devices.values()) { d.ready = false; d.progress = 0; d.drift = 0; }
  }

  /**
   * Apply one client message. `ctx` = { now, send(id,msg), broadcast(msg), roster() }.
   * Returns true when the roster should be republished.
   */
  function handle(room, device, msg, ctx) {
    const isHost = device.id === room.hostId;
    device.lastSeen = ctx.now();

    switch (msg.t) {
      case 'sync':
        ctx.send(device.id, { t: 'sync', c: msg.c, s: ctx.now() });
        return false;

      case 'state': {
        const p = msg.patch || {};
        const num = (k, lo, hi, round) => {
          if (typeof p[k] !== 'number' || !isFinite(p[k])) return;
          device[k] = round ? Math.round(clamp(p[k], lo, hi)) : clamp(p[k], lo, hi);
        };
        num('rtt', 0, 1e5); num('progress', 0, 1); num('drift', -1e5, 1e5);
        num('skew', -1e4, 1e4); num('volume', 0, 1); num('trim', -500, 500, true);
        num('battery', 0, 100, true);
        num('lat', 0, 2000);
        if (typeof p.tsrc === 'string') device.tsrc = p.tsrc.slice(0, 12);
        if (typeof p.ready === 'boolean') device.ready = p.ready;
        if (typeof p.muted === 'boolean') device.muted = p.muted;
        if (typeof p.charging === 'boolean') device.charging = p.charging;
        if (typeof p.awake === 'boolean') device.awake = p.awake;
        if (typeof p.mode === 'string') device.mode = p.mode;
        if (typeof p.net === 'string') device.net = p.net.slice(0, 16);
        if (typeof p.name === 'string' && p.name.trim()) device.name = p.name.slice(0, 24);
        if (p.calib === null || typeof p.calib === 'number') device.calib = p.calib;
        if (p.pos === null || (p.pos && typeof p.pos.x === 'number')) device.pos = p.pos;
        return true;
      }

      /* Anything the devices need to say to each other (acoustic ranging) goes
         through here, so the positioning logic lives entirely client-side. */
      case 'relay': {
        const wrapped = { t: 'relayed', from: device.id, payload: msg.payload };
        if (msg.to === '*') ctx.broadcast(wrapped, device.id);
        else if (msg.to === 'host') ctx.send(room.hostId, wrapped);
        else if (room.devices.has(msg.to)) ctx.send(msg.to, wrapped);
        return false;
      }

      default: break;
    }

    if (!isHost) return false;      // everything below is the host's privilege

    switch (msg.t) {
      case 'play': {
        if (!room.track) return false;
        room.playback = {
          mode: 'playing', trackId: room.track.id,
          anchorServer: ctx.now() + room.syncBuffer,
          anchorPos: Math.max(0, Number(msg.position) || 0),
          bpm: room.playback.bpm,
        };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'pause': {
        const pos = Number(msg.position);
        room.playback = {
          mode: 'paused', trackId: room.playback.trackId, anchorServer: ctx.now(),
          anchorPos: isFinite(pos) ? Math.max(0, pos) : room.playback.anchorPos,
          bpm: room.playback.bpm,
        };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'seek': {
        const playing = room.playback.mode === 'playing';
        room.playback = {
          mode: playing ? 'playing' : 'paused', trackId: room.playback.trackId,
          anchorServer: ctx.now() + (playing ? room.syncBuffer : 0),
          anchorPos: Math.max(0, Number(msg.position) || 0),
          bpm: room.playback.bpm,
        };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'metronome': {
        room.playback = msg.on
          ? { mode: 'metronome', trackId: null, anchorServer: ctx.now() + room.syncBuffer, anchorPos: 0, bpm: clamp(Number(msg.bpm) || 100, 30, 240) }
          : { mode: 'idle', trackId: room.track ? room.track.id : null, anchorServer: ctx.now(), anchorPos: 0, bpm: room.playback.bpm };
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now() });
        return true;
      }
      case 'buffer': {
        room.syncBuffer = clamp(Number(msg.ms) || 700, 150, 3000);
        return true;
      }
      case 'resync': {
        const pb = room.playback;
        if (pb.mode === 'playing') {
          const pos = pb.anchorPos + (ctx.now() - pb.anchorServer) / 1000;
          room.playback = Object.assign({}, pb, { anchorServer: ctx.now() + room.syncBuffer, anchorPos: Math.max(0, pos) });
        } else if (pb.mode === 'metronome') {
          room.playback = Object.assign({}, pb, { anchorServer: ctx.now() + room.syncBuffer });
        } else return false;
        ctx.broadcast({ t: 'playback', playback: room.playback, serverNow: ctx.now(), hard: true });
        return true;
      }
      case 'device': {
        const target = room.devices.get(msg.id);
        if (!target) return false;
        const patch = {};
        if (typeof msg.mode === 'string') { target.mode = msg.mode; patch.mode = msg.mode; }
        if (typeof msg.volume === 'number') { target.volume = clamp(msg.volume, 0, 1); patch.volume = target.volume; }
        if (typeof msg.muted === 'boolean') { target.muted = msg.muted; patch.muted = msg.muted; }
        if (typeof msg.trim === 'number') { target.trim = Math.round(clamp(msg.trim, -500, 500)); patch.trim = target.trim; }
        ctx.send(target.id, { t: 'apply', patch });
        return true;
      }
      case 'kick': {
        if (msg.id === device.id || !room.devices.has(msg.id)) return false;
        ctx.send(msg.id, { t: 'kicked' });
        ctx.drop(msg.id);
        return true;
      }
      case 'makeHost': {
        const target = room.devices.get(msg.id);
        if (!target) return false;
        device.isHost = false;
        target.isHost = true;
        room.hostId = target.id;
        ctx.broadcast({ t: 'hostChanged', hostId: target.id });
        return true;
      }
      default: return false;
    }
  }

  /** Devices that have said nothing for a while are gone, whatever the socket thinks. */
  function reap(room, nowMs, maxSilenceMs) {
    const dead = [];
    for (const d of room.devices.values()) {
      if (nowMs - d.lastSeen > maxSilenceMs) dead.push(d.id);
    }
    return dead;
  }

  return { CODE_ALPHABET, makeCode, reap, findByKey, createRoom, createDevice, publicDevice, snapshot, join, leave, setTrack, handle };
}));
