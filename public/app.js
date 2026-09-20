/* Ensemble — application state, room UI and wiring.
 * Transport lives in net.js, audio in audio.js, acoustics in acoustic.js.
 */
'use strict';

/* ────────────────────────────── device sensors ─────────────────────────── */
/* A phone in a speaker group has hardware worth using: the screen sleeping is
   the single most common way a device drops out, a dying battery is worth
   warning the host about, and the motion sensors make good remote controls. */

const Sensors = {
  wakeLock: null, wakeWanted: localStorage.getItem('ensemble.wake') !== '0',
  motionOn: false, hapticOn: localStorage.getItem('ensemble.haptic') === '1',
  battery: null, lastShake: 0, faceDownSince: 0, faceDownMuted: false,
  lastPulse: 0,

  init() {
    this.wireWake();
    this.wireBattery();
    this.wireNet();
    this.wireMotion();
    this.wireHaptic();
    this.render();
  },

  /* ── screen wake lock: the fix for "my phone went quiet in my pocket" ── */
  wireWake() {
    const sw = $('#sw-wake');
    const supported = 'wakeLock' in navigator;
    if (!supported) {
      $('#wake-sub').textContent = 'Not supported in this browser — keep the screen on manually';
      sw.disabled = true;
      $('#s-wake').classList.add('off');
      return;
    }
    sw.addEventListener('click', () => {
      this.wakeWanted = !this.wakeWanted;
      localStorage.setItem('ensemble.wake', this.wakeWanted ? '1' : '0');
      this.wakeWanted ? this.acquireWake() : this.releaseWake();
      this.render();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.wakeWanted && !this.wakeLock) this.acquireWake();
    });
  },
  async acquireWake() {
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; this.render(); });
      $('#wake-sub').textContent = 'Holding the screen on while this device plays';
      $('#s-wake').classList.remove('off');
    } catch (e) {
      this.wakeLock = null;
      $('#wake-sub').textContent = 'Blocked by this browser — keep the screen on manually';
      $('#s-wake').classList.add('off');
    }
    this.render();
    pushState({ awake: !!this.wakeLock });
  },
  async releaseWake() {
    try { await (this.wakeLock && this.wakeLock.release()); } catch {}
    this.wakeLock = null;
    pushState({ awake: false });
  },

  /* ── battery: a speaker that is about to die is the host's problem ── */
  async wireBattery() {
    if (!navigator.getBattery) {
      $('#bat-sub').textContent = 'Not exposed by this browser';
      $('#s-battery').classList.add('off');
      $('#bat-value').textContent = 'n/a';
      return;
    }
    try {
      const b = await navigator.getBattery();
      this.battery = b;
      const report = () => {
        const pct = Math.round(b.level * 100);
        $('#bat-value').textContent = `${pct}%${b.charging ? ' ⚡' : ''}`;
        $('#bat-sub').textContent = b.charging ? 'Charging' :
          (pct <= 20 ? 'Low — the host can see this' : 'Shared with the host');
        pushState({ battery: pct, charging: b.charging });
      };
      ['levelchange', 'chargingchange'].forEach((e) => b.addEventListener(e, report));
      report();
    } catch {
      $('#bat-sub').textContent = 'Unavailable';
      $('#s-battery').classList.add('off');
    }
  },

  wireNet() {
    const c = navigator.connection || navigator.webkitConnection;
    if (!c) { $('#net-value').textContent = 'n/a'; $('#s-net').classList.add('off'); return; }
    const report = () => {
      const label = c.effectiveType || 'unknown';
      $('#net-value').textContent = c.downlink ? `${label} · ${c.downlink} Mb/s` : label;
      pushState({ net: label });
      // A slow link needs a longer lead; only the host can act on it.
      if (isHost() && App.room && /2g|slow/.test(label) && App.room.syncBuffer < 1500) {
        $('#net-sub').textContent = 'Slow link — consider a 1.5 s sync buffer';
      }
    };
    c.addEventListener && c.addEventListener('change', report);
    report();
  },

  /* ── motion: shake to resync, face-down to mute ── */
  wireMotion() {
    const btn = $('#btn-motion');
    const needsPermission = typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';
    if (typeof DeviceMotionEvent === 'undefined') {
      $('#motion-sub').textContent = 'No motion sensors on this device';
      btn.disabled = true; $('#s-motion').classList.add('off');
      return;
    }
    btn.addEventListener('click', async () => {
      if (this.motionOn) { this.stopMotion(); return; }
      if (needsPermission) {
        let state;
        try { state = await DeviceMotionEvent.requestPermission(); } catch { state = 'denied'; }
        if (state !== 'granted') { toast('Motion access denied'); return; }
      }
      this.startMotion();
    });
  },
  startMotion() {
    this._motion = (e) => this.onMotion(e);
    window.addEventListener('devicemotion', this._motion);
    this.motionOn = true;
    $('#btn-motion').textContent = 'Disable';
    this.render();
    toast('Shake to resync · face-down to mute');
  },
  stopMotion() {
    window.removeEventListener('devicemotion', this._motion);
    this.motionOn = false;
    $('#btn-motion').textContent = 'Enable';
    this.render();
  },
  onMotion(e) {
    const a = e.acceleration || {};
    const g = e.accelerationIncludingGravity || {};
    const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    const now = performance.now();

    if (mag > 18 && now - this.lastShake > 1500) {
      this.lastShake = now;
      if (isHost()) { send({ t: 'resync' }); toast('Resyncing the room'); }
      else { Engine.stop(); App.appliedPlayback = ''; applyPlayback(); toast('Resynced this device'); }
      if (navigator.vibrate) navigator.vibrate(40);
    }

    // Screen down on a table = "I am not using this, just be a speaker" → mute.
    const down = (g.z || 0) < -8.5;
    if (down) {
      if (!this.faceDownSince) this.faceDownSince = now;
      else if (now - this.faceDownSince > 800 && !App.muted) {
        this.faceDownMuted = true;
        App.muted = true; Engine.setMuted(true);
        $('#btn-mute').classList.add('on');
        pushState({ muted: true });
        toast('Face-down — muted');
      }
    } else {
      this.faceDownSince = 0;
      if (this.faceDownMuted && App.muted) {
        this.faceDownMuted = false;
        App.muted = false; Engine.setMuted(false);
        $('#btn-mute').classList.remove('on');
        pushState({ muted: false });
      }
    }
  },

  /* ── haptics: a muted phone can still carry the beat ── */
  wireHaptic() {
    const sw = $('#sw-haptic');
    if (!navigator.vibrate) {
      $('#haptic-sub').textContent = 'No vibration motor exposed here';
      sw.disabled = true; $('#s-haptic').classList.add('off');
      this.hapticOn = false;
      return;
    }
    sw.addEventListener('click', () => {
      this.hapticOn = !this.hapticOn;
      localStorage.setItem('ensemble.haptic', this.hapticOn ? '1' : '0');
      if (this.hapticOn) navigator.vibrate(25);
      this.render();
    });
  },
  /** Called from the animation loop: onset detection on the bass band. */
  pulse(bassLevel) {
    if (!this.hapticOn || !navigator.vibrate) return;
    const now = performance.now();
    if (bassLevel > 0.72 && now - this.lastPulse > 220) {
      this.lastPulse = now;
      navigator.vibrate(22);
    }
  },

  render() {
    $('#sw-wake').setAttribute('aria-checked', String(!!this.wakeLock));
    $('#s-wake').classList.toggle('on', !!this.wakeLock);
    $('#sw-haptic').setAttribute('aria-checked', String(!!this.hapticOn));
    $('#s-haptic').classList.toggle('on', !!this.hapticOn);
    $('#s-motion').classList.toggle('on', this.motionOn);
    $('#s-battery').classList.toggle('on', !!this.battery);
    const live = [!!this.wakeLock, this.motionOn, this.hapticOn, !!this.battery].filter(Boolean).length;
    $('#sensor-count').textContent = `${live} active`;
  },
};

/* ──────────────────────────────── app state ────────────────────────────── */

const App = {
  ws: null, id: null, room: null, connected: false,
  loadedTrackId: null, loadingTrackId: null, pendingBytes: null,
  appliedPlayback: '', scrubbing: false, lanInfo: null,
  name: localStorage.getItem('ensemble.name') || '',
  mode: localStorage.getItem('ensemble.mode') || 'stereo',
  trim: Number(localStorage.getItem('ensemble.trim') || 0),
  volume: Number(localStorage.getItem('ensemble.volume') || 1),
  muted: false,
};
const me = () => App.room && App.room.devices.find((d) => d.id === App.id);
const isHost = () => !!App.room && App.room.hostId === App.id;
const playback = () => (App.room && App.room.playback) || { mode: 'idle' };

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ───────────────────────────────── network ─────────────────────────────── */

async function connectRoom(opts) {
  Net.onMessage = handleMessage;
  Net.onStatus = (status) => {
    if (status === 'connected') { App.connected = true; pumpSync(true); }
    if (status === 'closed') onDisconnected();
  };
  try {
    await Net.start({ create: opts.create, code: opts.code, name: App.name || defaultName(), mode: App.mode });
  } catch (err) {
    landingError(err.message || 'Could not start the session');
    throw err;
  }
}

function onDisconnected() {
  App.connected = false;
  if (!App.id) return;
  setSyncPill('bad', Net.mode === 'p2p' ? 'host gone' : 'reconnecting');
  Engine.stop(); Engine.stopMetronome();
  if (Net.mode === 'ws') setTimeout(() => connectRoom({ create: false, code: App.room ? App.room.code : null }), 1500);
  else toast('Lost the connection to the host');
}

function handleMessage(m) {
  if (!m || m instanceof ArrayBuffer) return;
  switch (m.t) {
    case 'sync': Clock.note(m.c, m.s); break;
    case 'welcome':
      App.id = m.id;
      applyRoom(m.room);
      show('session');
      Sensors.init();
      if (Sensors.wakeWanted) Sensors.acquireWake();
      renderShare();
      if (!Engine.unlocked()) showGate();
      pushState({ mode: App.mode, volume: App.volume, trim: App.trim });
      break;
    case 'roster': applyRoom(m.room); break;
    case 'playback':
      if (App.room) {
        App.room.playback = m.playback;
        if (m.hard) { Engine.stop(); App.appliedPlayback = ''; }
        applyPlayback();
        renderRoom();
      }
      break;
    case 'apply': {
      const p = m.patch || {};
      if (p.mode) {
        App.mode = p.mode; Engine.setMode(p.mode);
        App.modeGroup = (MODE_BY_ID[p.mode] || {}).group || 'room';
        localStorage.setItem('ensemble.mode', p.mode);
      }
      if (typeof p.volume === 'number') { App.volume = p.volume; Engine.setVolume(p.volume); }
      if (typeof p.muted === 'boolean') { App.muted = p.muted; Engine.setMuted(p.muted); }
      if (typeof p.trim === 'number') { App.trim = p.trim; Engine.setTrim(p.trim); localStorage.setItem('ensemble.trim', p.trim); }
      syncSelfControls();
      toast('Host adjusted this device');
      break;
    }
    case 'relayed': handleRelay(m.from, m.payload); break;
    case 'promoted': toast('You are the host now'); renderShare(); break;
    case 'kicked':
      toast('Removed from the session');
      setTimeout(() => location.reload(), 1200);
      break;
    case 'error':
      landingError(m.message || 'Something went wrong');
      break;
    default: break;
  }
}

/** Device-to-device traffic: the acoustic ranging session. */
function handleRelay(from, payload) {
  if (!payload) return;
  switch (payload.k) {
    case 'selfcal':
      setMapStatus('measuring this speaker…');
      Ranger.selfCalibrateLocal().then((r) => {
        setMapStatus(r.ok ? 'waiting for the room…' : 'this device could not hear itself');
        if (!r.ok) toast(r.why);
      });
      break;
    case 'chirp':
      setMapStatus(`listening (${payload.by === App.id ? 'my turn' : 'another device'})…`);
      Ranger.participate(payload.by, payload.at).then(() => setMapStatus(''));
      break;
    case 'heard':
      if (isHost()) Ranger.note(payload.by, from, payload.dt);
      break;
    case 'calresult':
      if (isHost()) Ranger.calResults.set(from, payload);
      break;
    default: break;
  }
}

function send(obj) { Net.send(obj); }
function pushState(patch) { Net.send({ t: 'state', patch }); }

/** Fast burst of exchanges on join, then a steady trickle that feeds the skew fit. */
function pumpSync(burst) {
  if (!App.connected) return;
  Net.send({ t: 'sync', c: performance.now() });
  const early = Clock.samples.length < 16;
  clearTimeout(pumpSync._t);
  pumpSync._t = setTimeout(() => pumpSync(false), burst && early ? 180 : (early ? 400 : 2000));
}

function defaultName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC';
  return 'Device';
}

/* ───────────────────────────── room + playback ─────────────────────────── */

function applyRoom(room) {
  App.room = room;
  renderRoom();
  if (room.track && room.track.id !== App.loadedTrackId && room.track.id !== App.loadingTrackId) loadTrack(room.track);
  if (!room.track) { App.loadedTrackId = null; Engine.buffer = null; }
  applyPlayback();
}

async function loadTrack(track) {
  App.loadingTrackId = track.id;
  App.loadedTrackId = null;
  Engine.stop(); Engine.buffer = null;
  pushState({ ready: false, progress: 0 });
  setBadge('Downloading…');
  let lastPush = 0;
  try {
    const bytes = await Net.fetchTrack(track, (frac) => {
      if (performance.now() - lastPush < 200) return;
      lastPush = performance.now();
      pushState({ progress: frac });
    });
    pushState({ progress: 1 });
    setBadge('Decoding…');
    if (!Engine.ctx) await Engine.unlock().catch(() => {});
    if (!Engine.ctx) { App.pendingBytes = bytes; App.loadingTrackId = null; showGate(); return; }
    Engine.buffer = await Engine.ctx.decodeAudioData(bytes);
    Engine.rebuild();                       // a 5.1 source needs a different graph than stereo
    renderSourceInfo();
    App.loadedTrackId = track.id;
    App.loadingTrackId = null;
    pushState({ ready: true, progress: 1 });
    App.appliedPlayback = '';
    applyPlayback();
    renderRoom();
  } catch (err) {
    App.loadingTrackId = null;
    setBadge('Transfer failed');
    toast(err.message || 'Could not load the track');
  }
}

function applyPlayback() {
  const pb = playback();
  const key = JSON.stringify(pb);
  const changed = key !== App.appliedPlayback;
  App.appliedPlayback = key;

  if (pb.mode !== 'metronome' && Engine.metroOn) Engine.stopMetronome();
  if (!Engine.unlocked()) { if (pb.mode === 'playing' || pb.mode === 'metronome') showGate(); return; }

  if (pb.mode === 'metronome') {
    if (changed || !Engine.metroOn) { Engine.stop(); Engine.startMetronome(pb.anchorServer, pb.bpm || 100); }
    return;
  }
  if (pb.mode === 'playing') {
    if (!Engine.buffer) return;
    if (changed || !Engine.source) {
      Engine.start(pb.anchorServer, pb.anchorPos, () => {
        if (isHost() && playback().mode === 'playing') send({ t: 'pause', position: 0 });
      });
    }
    return;
  }
  Engine.stop();
}

/** Where the room says the playhead should be at a given server time — the ideal
 *  line, deliberately unclamped so the corrector sees the truth during the pre-roll. */
function posAtServerTime(serverMs) {
  const pb = playback();
  if (pb.mode !== 'playing') return pb.anchorPos || 0;
  return pb.anchorPos + (serverMs - pb.anchorServer) / 1000;
}
/** Same value, clamped for display. */
function expectedPos() {
  const p = posAtServerTime(Clock.now());
  return clamp(p, 0, Engine.buffer ? Engine.buffer.duration : p);
}

/* ────────────────────────────── invite + QR ────────────────────────────── */

function shareUrl() {
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  return base + '#' + (App.room ? App.room.code : '');
}

let qrLoading = null;
function loadQR() {
  if (window.qrcode) return Promise.resolve();
  if (qrLoading) return qrLoading;
  qrLoading = new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = 'vendor/qrcode.min.js';
    el.onload = res; el.onerror = () => rej(new Error('qr'));
    document.head.appendChild(el);
  });
  return qrLoading;
}

async function renderShare() {
  if (!App.room) return;
  const url = shareUrl();
  $('#invite-code').textContent = App.room.code;
  $('#invite-url').textContent = url.replace(/^https?:\/\//, '');
  $('#transport-chip').textContent = Net.mode === 'p2p' ? 'peer to peer' : 'local network';
  $('#btn-share').hidden = !navigator.share;

  if (Net.mode === 'ws' && App.lanInfo && App.lanInfo.addresses && App.lanInfo.addresses.length &&
      /^(localhost|127\.)/.test(location.hostname)) {
    // A QR pointing at "localhost" is useless to a phone — point at the LAN address.
    $('#invite-hint').textContent = 'Phones must be on the same Wi-Fi as this computer.';
  }

  try {
    await loadQR();
    const target = qrTargetUrl();
    const qr = qrcode(0, 'M');
    qr.addData(target);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch {
    $('#qr').innerHTML = '<div class="qr-fallback">Type the code by hand — the QR library did not load.</div>';
  }
}

/** The URL a phone should actually open (never "localhost"). */
function qrTargetUrl() {
  const url = shareUrl();
  if (!/^(localhost|127\.0\.0\.1)/.test(location.hostname)) return url;
  const lan = App.lanInfo && App.lanInfo.addresses && App.lanInfo.addresses[0];
  if (!lan) return url;
  return url.replace(location.host, `${lan}:${App.lanInfo.port}`);
}

/* ─────────────────────────────── room map ──────────────────────────────── */

function setMapStatus(text) { const el = $('#map-status'); if (el) el.textContent = text || ''; }

function renderMapCard() {
  if (!App.room) return;
  const map = Ranger.map;
  const host = isHost();
  const canMap = host && App.room.devices.length >= 2 && Acoustic.supported();

  $('#btn-map').disabled = !canMap || Ranger.running;
  $('#btn-map').textContent = Ranger.running ? 'Mapping…' : (map ? 'Map again' : 'Map the room');
  $('#btn-mirror').hidden = !map || !host;
  $('#btn-apply-map').hidden = !map || !host;
  $('#map-chip').textContent = map ? `${map.ids.length} placed` : 'not mapped';

  const note = $('#map-note');
  if (!Acoustic.supported()) note.textContent = 'Microphone unavailable: ' + Acoustic.unsupportedReason() + '.';
  else if (!host) note.textContent = 'The host starts the mapping; this device will chirp and listen when asked.';
  else if (App.room.devices.length < 2) note.textContent = 'Needs at least two devices in the room.';
  else note.textContent = 'Keep the room quiet for about ten seconds. Every device needs its microphone allowed.';

  if (map) renderRoomMap($('#map-body'), map);
}

function wireTabs() {
  const tabs = $$('#panel-tabs button');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('sel', x === b));
    $$('.tab-body').forEach((body) => body.toggleAttribute('hidden', body.dataset.tab !== b.dataset.tab));
  }));
}

function wireMap() {
  $('#btn-map').addEventListener('click', async () => {
    if (!isHost() || Ranger.running) return;
    renderMapCard();
    try {
      const map = await Ranger.run(setMapStatus);
      setMapStatus('');
      if (map) {
        toast(`Mapped ${map.ids.length} devices`);
        pushState({ pos: null });
      }
    } catch (e) {
      setMapStatus('');
      toast(e.message || 'Mapping failed');
    }
    renderMapCard();
  });

  $('#btn-mirror').addEventListener('click', () => {
    Ranger.mirror = !Ranger.mirror;
    Ranger.resolveMap();
    renderMapCard();
  });

  $('#btn-apply-map').addEventListener('click', () => {
    const map = Ranger.map;
    if (!map || !isHost()) return;
    map.ids.forEach((id, i) => {
      const role = map.roles[id];
      const trim = map.delays[id];
      if (id === App.id) {
        App.mode = role; App.modeGroup = (MODE_BY_ID[role] || {}).group || 'room';
        Engine.setMode(role); Engine.setTrim(trim);
        App.trim = trim;
        localStorage.setItem('ensemble.mode', role);
        localStorage.setItem('ensemble.trim', trim);
        pushState({ mode: role, trim });
        syncSelfControls();
      } else {
        send({ t: 'device', id, mode: role, trim });
      }
      send({ t: 'state', patch: {} });
    });
    toast('Roles and delays applied from the map');
  });
}

/* ─────────────────────────────────── UI ────────────────────────────────── */

function show(which) {
  $('#landing').hidden = which !== 'landing';
  $('#session').hidden = which !== 'session';
}
function showGate() { $('#gate').hidden = false; }
function landingError(msg) { const e = $('#landing-error'); e.textContent = msg; e.hidden = false; }
function setBadge(text) { $('#art-badge').textContent = text; }
function setSyncPill(cls, text) {
  const p = $('#sync-pill');
  p.className = 'sync-pill' + (cls ? ' ' + cls : '');
  $('#sync-text').textContent = text;
}
function fillRange(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  el.style.setProperty('--fill', ((Number(el.value) - min) / (max - min) * 100) + '%');
}

function renderModes() {
  const cur = MODE_BY_ID[App.mode] || MODE_BY_ID.stereo;
  if (!App.modeGroup) App.modeGroup = cur.group;
  $$('#mode-group button').forEach((b) => b.classList.toggle('sel', b.dataset.group === App.modeGroup));

  const wrap = $('#modes');
  wrap.innerHTML = MODES.filter((m) => m.group === App.modeGroup).map((m) => `
    <button class="mode${m.id === App.mode ? ' sel' : ''}" data-mode="${m.id}" title="${m.hint}">
      ${m.short ? `<span class="badge">${m.short}</span>` : ''}
      ${m.icon}<span>${m.label}</span>
    </button>`).join('');
  $('#mode-hint').textContent = cur.hint;

  $$('.mode', wrap).forEach((b) => b.addEventListener('click', () => {
    App.mode = b.dataset.mode;
    localStorage.setItem('ensemble.mode', App.mode);
    Engine.setMode(App.mode);
    pushState({ mode: App.mode });
    renderModes();
  }));
  renderSourceInfo();
}

/** Say plainly whether this device is taking a real channel or a matrixed one. */
function renderSourceInfo() {
  const el = $('#source-info');
  if (!el) return;
  const ch = Engine.buffer ? Engine.buffer.numberOfChannels : 0;
  const isSurroundRole = (MODE_BY_ID[App.mode] || {}).group === 'surround';
  if (!ch) { el.textContent = ''; return; }
  if (ch >= 6) {
    el.textContent = isSurroundRole && Engine.discrete
      ? `${ch}-channel source — this device is playing its discrete channel.`
      : `${ch}-channel source — surround roles will take their real channel.`;
  } else {
    el.textContent = isSurroundRole
      ? 'Stereo source — this channel is matrix-upmixed (Pro Logic II style).'
      : `${ch === 1 ? 'Mono' : 'Stereo'} source.`;
  }
}

function syncSelfControls() {
  const vol = $('#volume');
  vol.value = Math.round(App.volume * 100); fillRange(vol);
  $('#vol-value').textContent = Math.round(App.volume * 100) + '%';
  const trim = $('#trim');
  trim.value = App.trim; fillRange(trim);
  $('#trim-value').textContent = (App.trim > 0 ? '+' : '') + App.trim + ' ms';
  $('#btn-mute').classList.toggle('on', App.muted);
  renderModes();
}

function renderRoom() {
  if (!App.room) return;
  $('#room-code').textContent = App.room.code;
  $('#host-tools').hidden = !isHost();
  $('#host-sync').hidden = !isHost();
  $('#device-count').textContent = App.room.devices.length;
  const self = me();
  if (self) $('#self-name-chip').textContent = self.name + (isHost() ? ' · host' : '');

  const tr = App.room.track;
  $('#track-title').textContent = tr ? tr.name.replace(/\.[a-z0-9]+$/i, '') : 'Nothing loaded';
  $('#track-sub').textContent = tr
    ? `${(tr.size / 1048576).toFixed(1)} MB · shared with ${App.room.devices.length} device${App.room.devices.length === 1 ? '' : 's'}`
    : (isHost() ? 'Drop an audio file below to share it with the room.' : 'Waiting for the host to add a track.');

  const canPlay = isHost() && !!tr;
  $('#btn-play').disabled = !canPlay;
  $('#btn-back15').disabled = !canPlay;
  $('#btn-fwd15').disabled = !canPlay;
  $('#scrub').disabled = !canPlay;

  const pl = playback().mode === 'playing';
  $('#btn-play').querySelector('.i-play').toggleAttribute('hidden', pl);
  $('#btn-play').querySelector('.i-pause').toggleAttribute('hidden', !pl);
  $('#art').classList.toggle('playing', pl || playback().mode === 'metronome');
  $('#btn-metro').textContent = playback().mode === 'metronome' ? 'Stop sync test tone' : 'Play sync test tone';

  $$('#buffer-seg button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.ms) === App.room.syncBuffer));
  $('#btn-layout').hidden = !isHost() || App.room.devices.length < 2;
  renderMapCard();
  renderDevices();
}

function renderDevices() {
  const host = isHost();
  const list = [...App.room.devices].sort((a, b) => (b.isHost - a.isHost) || (a.joinedAt - b.joinedAt));
  $('#devices').innerHTML = list.map((d) => {
    const mine = d.id === App.id;
    const link = d.rtt > 0.05 ? `±${Math.max(1, Math.round(d.rtt / 2))} ms`
      : (d.id === App.id && Net.isHub ? 'reference clock' : (d.ready || d.rtt ? 'sub-ms' : 'syncing…'));
    const dr = Math.round(d.drift);
    const drift = Math.abs(dr) < 10 ? '<span class="ok">in step</span>'
      : `<span class="warn">${dr > 0 ? '+' : ''}${dr} ms</span>`;
    const status = !App.room.track ? 'idle' : (d.ready ? drift : `loading ${Math.round(d.progress * 100)}%`);
    const extra = [];
    if (d.trim) extra.push(`trim ${d.trim > 0 ? '+' : ''}${d.trim} ms`);
    if (d.calib != null) extra.push(`${d.calib} ms measured`);
    if (d.muted) extra.push('muted');
    if (typeof d.battery === 'number') {
      extra.push(`<span class="bat${d.battery <= 20 && !d.charging ? ' low' : ''}">${d.battery}%${d.charging ? ' ⚡' : ''}</span>`);
    }
    if (d.awake) extra.push('screen held');
    return `
      <div class="device${d.isHost ? ' is-host' : ''}">
        <div class="avatar">${(d.name[0] || '?').toUpperCase()}</div>
        <div class="info">
          <div class="nm">${escapeHtml(d.name)}
            ${d.isHost ? '<span class="tag host">Host</span>' : ''}
            ${mine ? '<span class="tag you">You</span>' : ''}
          </div>
          <div class="meta">
            <span>${MODE_BY_ID[d.mode] ? MODE_BY_ID[d.mode].label : d.mode}</span>
            <span>${link}</span><span>${status}</span>${extra.map((e) => `<span>${e}</span>`).join('')}
          </div>
          ${d.ready || !App.room.track ? '' : `<div class="progress"><i style="width:${Math.round(d.progress * 100)}%"></i></div>`}
        </div>
        <div class="ctrl">
          ${host ? `<select data-dev="${d.id}">${modeOptions(d.mode)}</select>` : ''}
          ${host && !mine ? `<button class="icon-btn" data-kick="${d.id}" title="Remove device">×</button>` : ''}
        </div>
      </div>`;
  }).join('');

  $$('#devices select').forEach((sel) => sel.addEventListener('change', () => {
    send({ t: 'device', id: sel.dataset.dev, mode: sel.value });
  }));
  $$('#devices [data-kick]').forEach((b) => b.addEventListener('click', () => send({ t: 'kick', id: b.dataset.kick })));

  const lan = App.lanInfo && App.lanInfo.addresses && App.lanInfo.addresses[0];
  $('#join-hint').innerHTML = lan
    ? `On the same Wi-Fi, open <b>${lan}:${App.lanInfo.port}</b> and enter <b>${App.room.code}</b>.`
    : `Scan the code above, or enter <b>${App.room.code}</b> on any device that opens this page.`;
}

function modeOptions(selected) {
  const grp = (name, label) => `<optgroup label="${label}">` +
    MODES.filter((m) => m.group === name)
      .map((m) => `<option value="${m.id}"${m.id === selected ? ' selected' : ''}>${m.label}</option>`).join('') +
    '</optgroup>';
  return grp('room', 'Stereo & roles') + grp('surround', 'Surround 5.1 / 7.1');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── animation + correction loop ── */

const barEls = [];
const BAR_COUNT = 30;
let BAR_BINS = null;

/** Log-spaced band edges: even visual weight from bass to air. */
function computeBarBins(bins) {
  const lo = 1, hi = Math.min(bins - 1, 96);
  BAR_BINS = Array.from({ length: BAR_COUNT + 1 }, (_, i) =>
    Math.max(lo + i, Math.round(lo * Math.pow(hi / lo, i / BAR_COUNT))));
}

function initBars() {
  const b = $('#bars');
  b.innerHTML = '<i></i>'.repeat(BAR_COUNT);
  barEls.push(...$$('i', b));
}

let lastReport = 0;
let freqData = null;

/* Visuals only. requestAnimationFrame stops in a background tab, so nothing
   that matters for sync is allowed to live in here. */
function frame() {
  requestAnimationFrame(frame);
  if (!App.room) return;
  const pb = playback();
  const dur = Engine.buffer ? Engine.buffer.duration : 0;

  if (!App.scrubbing) {
    const pos = pb.mode === 'playing' ? expectedPos() : (pb.anchorPos || 0);
    $('#time-cur').textContent = fmt(pos);
    $('#time-dur').textContent = fmt(dur);
    const sc = $('#scrub');
    sc.value = dur ? clamp((pos / dur) * 1000, 0, 1000) : 0;
    fillRange(sc);
  }

  if (Engine.analyser && (pb.mode === 'playing' || pb.mode === 'metronome')) {
    if (!freqData || freqData.length !== Engine.analyser.frequencyBinCount) {
      freqData = new Uint8Array(Engine.analyser.frequencyBinCount);
      computeBarBins(freqData.length);
    }
    Engine.analyser.getByteFrequencyData(freqData);
    barEls.forEach((el, i) => {
      const lo = BAR_BINS[i], hi = Math.max(BAR_BINS[i + 1], lo + 1);
      let peak = 0;
      for (let k = lo; k < hi && k < freqData.length; k++) peak = Math.max(peak, freqData[k]);
      const v = Math.pow(peak / 255, 0.62);
      const prev = Number(el.dataset.v || 0);
      const next = v > prev ? v : prev * 0.82 + v * 0.18;      // fast attack, slow release
      el.dataset.v = next;
      el.style.height = (7 + next * 93) + '%';
      if (i === 2) Sensors.pulse(v);                            // bass band drives the haptics
    });
  } else {
    // idle: a slow, shallow breath so the panel is not dead
    barEls.forEach((el, i) => {
      el.style.height = (9 + Math.sin(Date.now() / 900 + i * 0.35) * 4) + '%';
    });
  }

  if (pb.mode === 'idle' || pb.mode === 'paused') setBadge(Engine.buffer ? 'Ready' : (App.room.track ? 'Loading…' : 'No track'));
  else if (pb.mode === 'metronome') setBadge('Sync test');
  else setBadge('Playing · ' + ((MODE_BY_ID[App.mode] || {}).label || ''));

  renderStats();
}

/* Correction runs on a timer: a hidden tab still gets ~1 Hz, and audio keeps
   playing while the page is not rendering. This is the loop that keeps the room together. */
function syncTick() {
  if (!App.room) return;
  const pb = playback();

  if (pb.mode === 'playing' && Engine.source) {
    const err = Engine.correct(posAtServerTime);
    if (Math.abs(err) > 0.25) { Engine.hardResyncs++; Engine.start(pb.anchorServer, pb.anchorPos); }
  } else if (pb.mode === 'playing' && !Engine.source && Engine.buffer && Engine.unlocked()) {
    Engine.start(pb.anchorServer, pb.anchorPos);          // recover from a stalled context
  }
  if (pb.mode === 'metronome') Engine.pumpMetronome();

  const t = performance.now();
  if (t - lastReport > 1500) {
    lastReport = t;
    if (Clock.ready) pushState({ rtt: Clock.rtt, skew: Clock.ppm(), drift: Engine.source ? Engine.lastError * 1000 : 0 });
  }
}

function renderStats() {
  if (!App.room) return;
  const q = Clock.rtt;
  if (!Clock.ready) setSyncPill('', 'syncing…');
  else if (Net.isHub && q < 0.25) setSyncPill('good', 'reference clock');
  else setSyncPill(q < 40 ? 'good' : (q < 140 ? '' : 'bad'), `${q < 1 ? q.toFixed(1) : q.toFixed(0)} ms rtt`);

  const jit = Clock.jitter();
  const jitEl = $('#st-offset');
  jitEl.textContent = Number.isFinite(jit) ? `±${jit.toFixed(2)} ms` : '—';
  jitEl.className = 'v' + (Number.isFinite(jit) ? (jit < 3 ? ' ok' : ' warn') : '');
  $('#st-rtt').textContent = Clock.ready ? `${Clock.rtt.toFixed(1)} ms` : '—';
  const ppm = Clock.ppm();
  const skewEl = $('#st-skew');
  skewEl.textContent = Clock.skew ? `${ppm > 0 ? '+' : ''}${ppm.toFixed(0)} ppm` : 'learning…';
  skewEl.className = 'v' + (Math.abs(ppm) > 200 ? ' warn' : '');

  const errMs = Engine.source ? Engine.lastError * 1000 : 0;
  const de = $('#st-drift');
  de.textContent = Engine.source ? `${errMs > 0 ? '+' : ''}${errMs.toFixed(1)} ms` : '—';
  de.className = 'v' + (Engine.source ? (Math.abs(errMs) < 10 ? ' ok' : ' warn') : '');

  $('#st-rate').textContent = Engine.rate === 1 ? 'idle' : `${((Engine.rate - 1) * 100).toFixed(2)}% rate`;

  const drifts = App.room ? App.room.devices.filter((d) => d.ready).map((d) => d.drift + d.trim) : [];
  const spreadEl = $('#st-spread');
  if (drifts.length > 1) {
    const spread = Math.max(...drifts) - Math.min(...drifts);
    spreadEl.textContent = `${spread.toFixed(0)} ms`;
    spreadEl.className = 'v' + (spread < 20 ? ' ok' : ' warn');
  } else { spreadEl.textContent = '—'; spreadEl.className = 'v'; }

  const st = $('#sync-state');
  st.textContent = !Clock.ready ? 'measuring' : (Math.abs(errMs) < 10 ? 'locked' : 'correcting');
}

/* ──────────────────────────────── upload ───────────────────────────────── */

async function uploadFile(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|wav|flac|ogg|aac|aiff?)$/i.test(file.name)) {
    toast('That doesn\u2019t look like an audio file'); return;
  }
  const bar = $('#upload-bar'); bar.hidden = false;
  const fill = bar.querySelector('i'); fill.style.width = '0%';
  $('#dropzone-text').textContent = (Net.mode === 'p2p' ? 'Sharing ' : 'Uploading ') + file.name;
  try {
    await Net.publishTrack(file, (frac) => { fill.style.width = (frac * 100) + '%'; });
  } catch (e) {
    toast('Could not share that file');
  } finally {
    bar.hidden = true;
    $('#dropzone-text').textContent = 'Drop another file, or choose one';
  }
}

/* ──────────────────────────────── wiring ───────────────────────────────── */

const codeValue = () => $$('#code-input input').map((i) => i.value.toUpperCase()).join('');

function wireLanding() {
  const nameInput = $('#device-name');
  nameInput.value = App.name;
  nameInput.placeholder = defaultName();
  nameInput.addEventListener('input', () => {
    App.name = nameInput.value.trim().slice(0, 24);
    localStorage.setItem('ensemble.name', App.name);
  });

  const boxes = $$('#code-input input');
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'Enter') join();
    });
    box.addEventListener('paste', (e) => {
      const txt = (e.clipboardData.getData('text') || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4);
      if (!txt) return;
      e.preventDefault();
      boxes.forEach((b, k) => { b.value = txt[k] || ''; });
      boxes[Math.min(txt.length, 3)].focus();
    });
  });

  $('#btn-host').addEventListener('click', async () => {
    const btn = $('#btn-host');
    btn.disabled = true; btn.textContent = 'Starting…';
    await Engine.unlock().catch(() => {});
    try { await connectRoom({ create: true }); }
    finally { btn.disabled = false; btn.textContent = 'Start session'; }
  });
  $('#btn-join').addEventListener('click', join);

  async function join() {
    const code = codeValue();
    if (code.length !== 4) { landingError('Enter the four-character code'); return; }
    $('#landing-error').hidden = true;
    const btn = $('#btn-join');
    btn.disabled = true; btn.textContent = 'Joining…';
    await Engine.unlock().catch(() => {});
    try { await connectRoom({ create: false, code }); }
    catch {} finally { btn.disabled = false; btn.textContent = 'Join'; }
  }

  Net.detectMode().then((mode) => {
    Net.mode = mode;
    $('#landing-note').textContent = mode === 'p2p'
      ? 'Peer to peer — devices connect straight to the host. Nothing is uploaded to a server.'
      : 'Local network — this machine is running the session server.';
    // A QR that says "localhost" is useless to a phone, so find the LAN address
    // whenever one is on offer, in either transport.
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    fetch('api/info').then((r) => r.json()).then((info) => {
      App.lanInfo = info;
      if (info.addresses && info.addresses.length && mode === 'ws') {
        $('#landing-note').textContent = `Other devices on this Wi-Fi: http://${info.addresses[0]}:${info.port}`;
      }
      if (App.room) renderShare();
    }).catch(() => {});
  });
}

function wireSession() {
  $('#btn-leave').addEventListener('click', () => location.reload());

  $('#btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(qrTargetUrl()); toast('Link copied'); }
    catch { toast(qrTargetUrl()); }
  });
  $('#btn-share').addEventListener('click', () => {
    if (!navigator.share) return;
    navigator.share({ title: 'Ensemble', text: `Join my session ${App.room.code}`, url: qrTargetUrl() }).catch(() => {});
  });

  $('#btn-play').addEventListener('click', () => {
    if (!isHost()) return;
    const pb = playback();
    if (pb.mode === 'playing') send({ t: 'pause', position: expectedPos() });
    else send({ t: 'play', position: pb.anchorPos || 0 });
  });
  $('#btn-back15').addEventListener('click', () => isHost() && send({ t: 'seek', position: Math.max(0, expectedPos() - 15) }));
  $('#btn-fwd15').addEventListener('click', () => isHost() && send({ t: 'seek', position: expectedPos() + 15 }));

  const scrub = $('#scrub');
  const endScrub = () => {
    if (!App.scrubbing) return;
    App.scrubbing = false;
    const dur = Engine.buffer ? Engine.buffer.duration : 0;
    if (dur && isHost()) send({ t: 'seek', position: (Number(scrub.value) / 1000) * dur });
  };
  scrub.addEventListener('pointerdown', () => { App.scrubbing = true; });
  scrub.addEventListener('input', () => {
    fillRange(scrub);
    const dur = Engine.buffer ? Engine.buffer.duration : 0;
    $('#time-cur').textContent = fmt((Number(scrub.value) / 1000) * dur);
  });
  scrub.addEventListener('change', endScrub);
  scrub.addEventListener('pointerup', endScrub);

  const vol = $('#volume');
  vol.addEventListener('input', () => {
    App.volume = Number(vol.value) / 100;
    Engine.setVolume(App.volume);
    localStorage.setItem('ensemble.volume', App.volume);
    $('#vol-value').textContent = vol.value + '%';
    fillRange(vol);
  });
  vol.addEventListener('change', () => pushState({ volume: App.volume }));

  $('#btn-mute').addEventListener('click', () => {
    App.muted = !App.muted; Engine.setMuted(App.muted);
    $('#btn-mute').classList.toggle('on', App.muted);
    pushState({ muted: App.muted });
  });

  const trim = $('#trim');
  const setTrim = (v, push) => {
    App.trim = clamp(Math.round(v / 5) * 5, -500, 500);
    trim.value = App.trim; fillRange(trim);
    $('#trim-value').textContent = (App.trim > 0 ? '+' : '') + App.trim + ' ms';
    Engine.setTrim(App.trim);
    localStorage.setItem('ensemble.trim', App.trim);
    if (push) pushState({ trim: App.trim });
  };
  trim.addEventListener('input', () => setTrim(Number(trim.value), false));
  trim.addEventListener('change', () => pushState({ trim: App.trim }));
  $('#trim-minus').addEventListener('click', () => setTrim(App.trim - 10, true));
  $('#trim-plus').addEventListener('click', () => setTrim(App.trim + 10, true));

  $('#btn-calibrate').addEventListener('click', async () => {
    const btn = $('#btn-calibrate'), out = $('#calib-value');
    if (Engine.calibrating) return;
    btn.disabled = true;
    try {
      const ms = await Engine.calibrate((s) => { out.textContent = s; });
      out.textContent = `${ms} ms speaker → mic`;
      pushState({ calib: ms });
      toast(`Measured ${ms} ms. Host can auto-align the room.`);
    } catch (e) {
      out.textContent = 'not measured';
      toast(e.message || 'Measurement failed');
    } finally { btn.disabled = false; }
  });

  $$('#mode-group button').forEach((b) => b.addEventListener('click', () => {
    App.modeGroup = b.dataset.group;
    renderModes();
  }));

  $('#btn-layout').addEventListener('click', () => {
    // Hand every device a speaker position, nearest device first.
    const list = [...App.room.devices].sort((a, b) => a.joinedAt - b.joinedAt);
    const plan = LAYOUTS[Math.min(list.length, 8)] || LAYOUTS[8];
    list.forEach((d, i) => {
      const mode = plan[i] || 'mono';
      if (d.id === App.id) {
        App.mode = mode; App.modeGroup = (MODE_BY_ID[mode] || {}).group || 'room';
        Engine.setMode(mode); localStorage.setItem('ensemble.mode', mode);
        pushState({ mode });
        renderModes();
      } else send({ t: 'device', id: d.id, mode });
    });
    toast(`${list.length}-speaker layout: ${plan.slice(0, list.length).map((m) => (MODE_BY_ID[m] || {}).short || MODE_BY_ID[m].label).join(' · ')}`);
  });

  $$('#buffer-seg button').forEach((b) => b.addEventListener('click', () => send({ t: 'buffer', ms: Number(b.dataset.ms) })));
  $('#btn-resync').addEventListener('click', () => { send({ t: 'resync' }); toast('Re-anchoring every device'); });

  $('#btn-autoalign').addEventListener('click', () => {
    const measured = App.room.devices.filter((d) => typeof d.calib === 'number');
    if (measured.length < 2) { toast('Need at least two devices to measure themselves first'); return; }
    // Delay every device to match the slowest one — the same trick an AV receiver
    // uses for speaker distance. Delaying is always safe; playing earlier is not.
    const slowest = Math.max(...measured.map((d) => d.calib));
    measured.forEach((d) => send({ t: 'device', id: d.id, trim: Math.round(slowest - d.calib) }));
    toast(`Aligned ${measured.length} devices to the slowest speaker`);
  });

  const dz = $('#dropzone'), fi = $('#file-input');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { uploadFile(fi.files[0]); fi.value = ''; });
  ['dragenter', 'dragover'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (ev) => uploadFile(ev.dataTransfer.files[0]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('#btn-metro').addEventListener('click', () => {
    if (!isHost()) return;
    send({ t: 'metronome', on: playback().mode !== 'metronome', bpm: 100 });
  });

  $('#btn-gate').addEventListener('click', async () => {
    const ok = await Engine.unlock().catch(() => false);
    if (!ok) { toast('Could not start audio — check silent mode and volume'); return; }
    $('#gate').hidden = true;
    Engine.setMode(App.mode); Engine.setVolume(App.volume); Engine.setMuted(App.muted); Engine.setTrim(App.trim);
    if (App.pendingBytes) {
      const bytes = App.pendingBytes; App.pendingBytes = null;
      try {
        Engine.buffer = await Engine.ctx.decodeAudioData(bytes);
        Engine.rebuild();
        renderSourceInfo();
        App.loadedTrackId = App.room.track && App.room.track.id;
        pushState({ ready: true, progress: 1 });
      } catch { toast('Could not decode that file'); }
    } else if (App.room && App.room.track && !Engine.buffer) {
      loadTrack(App.room.track);
    }
    App.appliedPlayback = '';
    applyPlayback();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space' && isHost()) { e.preventDefault(); $('#btn-play').click(); }
  });

  // Coming back from the background: the clock estimate is stale, so remeasure.
  // The corrector then closes whatever gap opened, hard-resyncing only if it is large.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !Engine.ctx) return;
    Clock.samples = []; Clock.ready = false;
    pumpSync(true);
    if (Engine.ctx.state === 'suspended') Engine.ctx.resume().catch(() => {});
  });
}

/* ──────────────────────────────── bootstrap ────────────────────────────── */

initBars();
wireLanding();
wireSession();
wireMap();
wireTabs();
renderModes();
syncSelfControls();
$$('input[type=range]').forEach(fillRange);
requestAnimationFrame(frame);
setInterval(syncTick, 700);

const hash = (location.hash || '').replace('#', '').toUpperCase();
if (/^[A-Z0-9]{4}$/.test(hash)) $$('#code-input input').forEach((b, i) => { b.value = hash[i] || ''; });
