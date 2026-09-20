/* Ensemble — clock, channel modes and the playback engine.
 *
 * Sync model (the same shape Snapcast / AirPlay use):
 *   1. NTP-style exchange with the server, filtered to the lowest-latency samples,
 *      with a least-squares fit that also estimates clock *skew* (quartz drift).
 *   2. Every command carries an absolute server timestamp plus a fixed sync buffer,
 *      so all devices schedule the same sample for the same instant.
 *   3. Residual drift is removed continuously by micro-resampling (playbackRate),
 *      with a hard re-schedule only when we fall badly out of step.
 *   4. Per-device output latency is compensated — measured with the mic, or by hand.
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2, '0')}`;
};
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none">${d}</svg>`;

/* ───────────────────────────── channel modes ───────────────────────────── */

const MODES = [
  /* ── one device, playing a share of a stereo mix ── */
  { id: 'stereo', group: 'room', label: 'Stereo', hint: 'Full left/right mix, exactly as recorded.',
    icon: svg('<rect x="3" y="7" width="7" height="10" rx="2" fill="currentColor" opacity=".9"/><rect x="14" y="7" width="7" height="10" rx="2" fill="currentColor" opacity=".9"/>') },
  { id: 'mono', group: 'room', label: 'Mono', hint: 'Both channels summed — the safe choice for a single small speaker.',
    icon: svg('<circle cx="12" cy="12" r="6.5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/>') },
  { id: 'wide', group: 'room', label: 'Wide', hint: 'Mid/side widening with a Haas delay — a big image from one device.',
    icon: svg('<path d="M12 6v12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7.5 8.5a5 5 0 0 0 0 7M4.5 6a9 9 0 0 0 0 12M16.5 8.5a5 5 0 0 1 0 7M19.5 6a9 9 0 0 1 0 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>') },
  { id: 'left', group: 'room', label: 'Left', hint: 'Only the left channel. Pair it with a device set to Right.',
    icon: svg('<path d="M13 5 7 9H4v6h3l6 4z" fill="currentColor"/>') },
  { id: 'right', group: 'room', label: 'Right', hint: 'Only the right channel. Pair it with a device set to Left.',
    icon: svg('<path d="M11 5l6 4h3v6h-3l-6 4z" fill="currentColor"/>') },
  { id: 'center', group: 'room', label: 'Vocals', hint: 'Centre content, band-limited to the vocal range. A dialogue speaker.',
    icon: svg('<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2"/><path d="M6 12a6 6 0 0 0 12 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') },
  { id: 'side', group: 'room', label: 'Ambience', hint: 'Only the stereo difference — reverb and room tone.',
    icon: svg('<path d="M4 12h3l3-6 4 12 3-6h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>') },
  { id: 'bass', group: 'room', label: 'Bass', hint: 'Low-pass below 150 Hz. A laptop as the group subwoofer.',
    icon: svg('<path d="M3 12c2.5 0 2.5-6 5-6s2.5 12 5 12 2.5-6 5-6h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') },
  { id: 'treble', group: 'room', label: 'Highs', hint: 'High-pass above 2.2 kHz — sparkle for phones with no low end.',
    icon: svg('<path d="M3 12h2l1.5-4 2 8 2-10 2 12 2-8 1.5 2H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>') },

  /* ── one device = one speaker of a 5.1 / 7.1 layout ── */
  { id: 'fl', group: 'surround', label: 'Front L', short: 'FL', hint: 'Front left of the layout. Stand it to the left of the screen.',
    icon: svg('<path d="M12 21 5 14V6h6l7 7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8.5" cy="9.5" r="1.6" fill="currentColor"/>') },
  { id: 'fc', group: 'surround', label: 'Center', short: 'C', hint: 'Centre channel — dialogue and lead vocals. Put it under the screen.',
    icon: svg('<rect x="4" y="8" width="16" height="8" rx="3" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>') },
  { id: 'fr', group: 'surround', label: 'Front R', short: 'FR', hint: 'Front right of the layout. Stand it to the right of the screen.',
    icon: svg('<path d="m12 21 7-7V6h-6l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="15.5" cy="9.5" r="1.6" fill="currentColor"/>') },
  { id: 'sl', group: 'surround', label: 'Surround L', short: 'SL', hint: 'Side-left surround: ambience, delayed and band-limited.',
    icon: svg('<path d="M4 4v16M9 8a6 6 0 0 1 0 8M13.5 5a11 11 0 0 1 0 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>') },
  { id: 'sr', group: 'surround', label: 'Surround R', short: 'SR', hint: 'Side-right surround: ambience, delayed and band-limited.',
    icon: svg('<path d="M20 4v16M15 8a6 6 0 0 0 0 8M10.5 5a11 11 0 0 0 0 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>') },
  { id: 'lfe', group: 'surround', label: 'LFE', short: 'LFE', hint: 'Low frequency effects — the .1. Anything with a big speaker.',
    icon: svg('<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>') },
  { id: 'rl', group: 'surround', label: 'Rear L', short: 'RL', hint: 'Back-left of a 7.1 layout — the longest delay in the room.',
    icon: svg('<path d="M12 3 5 10v8h6l7-7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8.5" cy="14.5" r="1.6" fill="currentColor"/>') },
  { id: 'rr', group: 'surround', label: 'Rear R', short: 'RR', hint: 'Back-right of a 7.1 layout — the longest delay in the room.',
    icon: svg('<path d="m12 3 7 7v8h-6l-7-7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="15.5" cy="14.5" r="1.6" fill="currentColor"/>') },
];

/* Channel order of a discrete multichannel file (WAVE / AAC): FL FR FC LFE SL SR RL RR. */
const DISCRETE_INDEX = { fl: 0, fr: 1, fc: 2, lfe: 3, sl: 4, sr: 5, rl: 6, rr: 7 };

/* Which speaker each device takes, by room size. Fewer devices get the channels
   that matter most; the rest of the mix is folded into them by the matrix. */
const LAYOUTS = {
  1: ['stereo'],
  2: ['fl', 'fr'],
  3: ['fl', 'fr', 'fc'],
  4: ['fl', 'fr', 'sl', 'sr'],
  5: ['fl', 'fr', 'fc', 'sl', 'sr'],
  6: ['fl', 'fr', 'fc', 'lfe', 'sl', 'sr'],
  7: ['fl', 'fr', 'fc', 'lfe', 'sl', 'sr', 'rl'],
  8: ['fl', 'fr', 'fc', 'lfe', 'sl', 'sr', 'rl', 'rr'],
};

const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

/* ─────────────────────────────── clock sync ────────────────────────────── */

const Clock = {
  samples: [],          // { t: local midpoint (ms), offset, delay }
  offset: 0,            // server − local, valid at `at`
  at: 0,
  skew: 0,              // seconds per second between the two quartz clocks
  rtt: Infinity,
  ready: false,

  note(c, s) {
    const t1 = performance.now();
    const delay = t1 - c;                 // round trip
    const offset = s - (c + t1) / 2;      // NTP: server clock − local midpoint
    this.samples.push({ t: (c + t1) / 2, offset, delay });
    const cutoff = t1 - 120_000;
    while (this.samples.length > 400 || (this.samples.length && this.samples[0].t < cutoff)) this.samples.shift();
    this.solve();
  },

  solve() {
    const n = this.samples.length;
    if (!n) return;
    // Keep only the fastest exchanges: a long round trip means an asymmetric path,
    // and an asymmetric path is exactly what biases an NTP offset.
    const byDelay = [...this.samples].sort((a, b) => a.delay - b.delay);
    this.rtt = byDelay[0].delay;
    const keep = byDelay.slice(0, Math.max(4, Math.ceil(n * 0.25))).sort((a, b) => a.t - b.t);

    const span = keep[keep.length - 1].t - keep[0].t;
    let offsetNow, skew = 0;
    if (keep.length >= 8 && span > 25_000) {
      // Least squares offset(t) = a + b·t. b is the relative drift of the two clocks.
      const mt = keep.reduce((s, p) => s + p.t, 0) / keep.length;
      const mo = keep.reduce((s, p) => s + p.offset, 0) / keep.length;
      let num = 0, den = 0;
      for (const p of keep) { num += (p.t - mt) * (p.offset - mo); den += (p.t - mt) ** 2; }
      skew = clamp(den ? num / den : 0, -0.0005, 0.0005);   // ±500 ppm sanity bound
      offsetNow = mo + skew * (performance.now() - mt);
    } else {
      offsetNow = keep.reduce((s, p) => s + p.offset, 0) / keep.length;
    }

    this.skew = skew;
    this.at = performance.now();
    if (!this.ready) { this.offset = offsetNow; this.ready = n >= 4; }
    else this.offset += (offsetNow - this.offset) * 0.25;   // creep, never jump
  },

  /** Spread of the offset estimate — the honest measure of how well we know the clock. */
  jitter() {
    if (this.samples.length < 4) return NaN;
    const byDelay = [...this.samples].sort((a, b) => a.delay - b.delay);
    const keep = byDelay.slice(0, Math.max(4, Math.ceil(this.samples.length * 0.25)));
    const m = keep.reduce((s, p) => s + p.offset, 0) / keep.length;
    return Math.sqrt(keep.reduce((s, p) => s + (p.offset - m) ** 2, 0) / keep.length);
  },

  /** Server time for a given local performance-clock reading. */
  toServer(perfMs) { return perfMs + this.offset + (perfMs - this.at) * this.skew; },
  now() { return this.toServer(performance.now()); },
  ppm() { return this.skew * 1e6; },
};

/* ────────────────────────────── audio graph ────────────────────────────── */

/**
 * Build the per-device signal chain. A device plays one role: a slice of a
 * stereo mix, or one speaker of a surround layout.
 *
 * With a discrete multichannel source (a 5.1 file), the surround roles take
 * their real channel. With ordinary stereo they are matrix-upmixed, in the
 * spirit of Pro Logic II: centre from the mid signal, surrounds from the side
 * signal, delayed and band-limited so the room feels wrapped rather than doubled.
 */
function buildGraph(ctx, mode, channels = 2) {
  const discrete = channels >= 6 && DISCRETE_INDEX[mode] != null && DISCRETE_INDEX[mode] < channels;

  const input = ctx.createGain();
  input.channelCount = discrete ? channels : 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = discrete ? 'discrete' : 'speakers';
  const out = ctx.createGain();

  const mk = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filt = (type, freq, q) => {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  };
  const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };

  if (mode === 'stereo') { input.connect(out); return { input, out, discrete: false }; }

  const sp = ctx.createChannelSplitter(discrete ? channels : 2);
  const mg = ctx.createChannelMerger(2);
  input.connect(sp);
  const both = (n) => { n.connect(mg, 0, 0); n.connect(mg, 0, 1); };
  const sum = (gl, gr) => {                      // weighted L/R sum as one node
    const a = mk(gl), b = mk(gr), s = mk(1);
    sp.connect(a, 0); sp.connect(b, 1); a.connect(s); b.connect(s);
    return s;
  };
  const delay = (sec) => { const d = ctx.createDelay(0.2); d.delayTime.value = sec; return d; };

  if (discrete) {
    // The file already carries this speaker's channel — take it untouched.
    const g = mk(mode === 'lfe' ? 1.4 : 1);
    sp.connect(g, DISCRETE_INDEX[mode]);
    both(g);
    mg.connect(out);
    return { input, out, discrete: true };
  }

  switch (mode) {
    /* ── shares of a stereo mix ── */
    case 'mono': both(sum(0.5, 0.5)); break;
    case 'left': { const a = mk(1); sp.connect(a, 0); both(a); break; }
    case 'right': { const a = mk(1); sp.connect(a, 1); both(a); break; }
    case 'center': both(chain(sum(0.5, 0.5), filt('highpass', 180), filt('lowpass', 6000))); break;
    case 'side': both(sum(0.75, -0.75)); break;
    case 'bass': both(chain(sum(0.5, 0.5), filt('lowpass', 150, 0.7), mk(1.5))); break;
    case 'treble': both(chain(sum(0.5, 0.5), filt('highpass', 2200))); break;
    case 'wide': {
      const W = 1.7;
      const mid = sum(0.5, 0.5);
      mid.connect(mg, 0, 0); mid.connect(mg, 0, 1);
      const side = chain(sum(0.5 * W, -0.5 * W), filt('highpass', 300), delay(0.008));
      side.connect(mg, 0, 0);
      const inv = mk(-1); side.connect(inv); inv.connect(mg, 0, 1);
      break;
    }

    /* ── matrix upmix: one speaker of a surround layout, out of a stereo mix ── */
    case 'fl': both(chain(sum(0.82, -0.18), filt('highpass', 90))); break;      // L minus some centre
    case 'fr': both(chain(sum(-0.18, 0.82), filt('highpass', 90))); break;
    case 'fc': both(chain(sum(0.5, 0.5), filt('highpass', 120), filt('lowpass', 7000), mk(1.05))); break;
    case 'lfe': both(chain(sum(0.5, 0.5), filt('lowpass', 120, 0.7), mk(1.7))); break;
    case 'sl': both(chain(sum(0.55, -0.55), delay(0.018), filt('highpass', 150), filt('lowpass', 8000))); break;
    case 'sr': both(chain(sum(-0.55, 0.55), delay(0.023), filt('highpass', 150), filt('lowpass', 8000))); break;
    case 'rl': both(chain(sum(0.5, -0.5), delay(0.032), filt('highpass', 200), filt('lowpass', 7000))); break;
    case 'rr': both(chain(sum(-0.5, 0.5), delay(0.038), filt('highpass', 200), filt('lowpass', 7000))); break;

    default: input.connect(out); return { input, out, discrete: false };
  }
  mg.connect(out);
  return { input, out, discrete: false };
}

/* ────────────────────────────── audio engine ───────────────────────────── */

const Engine = {
  ctx: null, analyser: null, graph: null, source: null, buffer: null,
  mode: 'stereo', volume: 1, muted: false, trim: 0,
  anchor: null,          // { x: ctx time at which `pos` is audible, pos }
  rate: 1, lastError: 0, corrections: 0, hardResyncs: 0, lateStarts: 0,
  tsrc: 'unknown', tsLag: 0,
  metroOn: false, bpm: 100, metroAnchor: 0, beat: 0,
  calib: null, calibrating: false,

  unlocked() { return !!this.ctx && this.ctx.state === 'running'; },

  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });   // smallest buffer: timing beats power here
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.72;
      this.analyser.connect(this.ctx.destination);
      this.rebuild();
    }
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch {} }
    if (this.ctx.state === 'running') {   // silent blip keeps iOS' gesture requirement happy
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      g.gain.value = 0.0001; o.connect(g).connect(this.ctx.destination);
      o.start(); o.stop(this.ctx.currentTime + 0.03);
    }
    return this.unlocked();
  },

  diagnostics() {
    const c = this.ctx;
    return {
      tsrc: this.tsrc,
      tsLagMs: +(this.tsLag * 1000).toFixed(1),
      outLatencyMs: +(this.outLatency() * 1000).toFixed(1),
      baseLatencyMs: +((c && c.baseLatency ? c.baseLatency : 0) * 1000).toFixed(1),
      sampleRate: c ? c.sampleRate : 0,
      state: c ? c.state : 'none',
      rate: +this.rate.toFixed(5),
      errMs: +(this.lastError * 1000).toFixed(1),
      lateStarts: this.lateStarts,
      hardResyncs: this.hardResyncs,
    };
  },

  outLatency() {
    const c = this.ctx;
    const l = (typeof c.outputLatency === 'number' && c.outputLatency > 0) ? c.outputLatency : (c.baseLatency || 0);
    return clamp(l, 0, 0.5);
  },

  /**
   * The audible frontier: contextTime `c` is the sample being heard at
   * performance time `p`. getOutputTimestamp gives this correlation directly —
   * it already accounts for the output pipeline, so no latency term is added here.
   */
  audibleNow() {
    const ctx = this.ctx;
    const nowPerf = performance.now();
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts) {
      const ct = ts.contextTime, pt = ts.performanceTime;
      const lag = ctx.currentTime - ct;    // audible frontier trails the render clock
      const age = nowPerf - pt;            // how fresh this correlation is
      // Every one of these has been seen in the wild: zeros, a performanceTime on
      // a different epoch, a correlation that stopped updating. Any of them would
      // put playback arbitrarily far out, so the pair has to be plausible first.
      if (Number.isFinite(ct) && Number.isFinite(pt) && ct > 0 && pt > 0 &&
          lag > -0.05 && lag < 1 && age > -50 && age < 1000) {
        this.tsrc = 'timestamp';
        this.tsLag = lag;
        return { c: ct, p: pt };
      }
      this.tsrc = 'rejected';
    } else this.tsrc = 'none';
    return { c: ctx.currentTime - this.outLatency(), p: nowPerf };
  },

  /** Context time at which a sample must be scheduled to be *heard* at server time S. */
  scheduleAt(serverMs) {
    const { c, p } = this.audibleNow();
    const perfTarget = performance.now() + (serverMs - Clock.now());
    return c + (perfTarget - p) / 1000;
  },

  sourceChannels() { return this.buffer ? this.buffer.numberOfChannels : 2; },

  rebuild() {
    if (!this.ctx) return;
    const next = buildGraph(this.ctx, this.mode, this.sourceChannels());
    next.out.gain.value = this.muted ? 0 : this.volume;
    next.out.connect(this.analyser);
    if (this.source) { try { this.source.disconnect(); } catch {} this.source.connect(next.input); }
    if (this.graph) { const old = this.graph; setTimeout(() => { try { old.out.disconnect(); } catch {} }, 150); }
    this.graph = next;
  },

  setMode(m) { if (m === this.mode) return; this.mode = m; this.rebuild(); },
  get discrete() { return !!(this.graph && this.graph.discrete); },
  setVolume(v) { this.volume = clamp(v, 0, 1); this.applyGain(); },
  setMuted(b) { this.muted = !!b; this.applyGain(); },
  applyGain() {
    if (!this.graph) return;
    const g = this.graph.out.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.02);
  },
  /** Positive trim = this speaker should sound *later*. The corrector glides us there. */
  setTrim(ms) { this.trim = ms; },

  heardPos(atCtx) {
    if (!this.anchor) return 0;
    return this.anchor.pos + (atCtx - this.anchor.x) * this.rate;
  },

  stop() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch {}
      try { this.source.disconnect(); } catch {}
    }
    this.source = null; this.anchor = null; this.rate = 1; this.lastError = 0;
  },

  /** Schedule so that at server time `anchorServer` the audible playhead is `anchorPos`. */
  start(anchorServer, anchorPos, onEnded) {
    if (!this.buffer || !this.ctx || this.ctx.state !== 'running') return;
    this.stop();
    const target = Math.max(Clock.now() + 90, anchorServer);   // never aim at the past
    const pos = anchorPos + (target - anchorServer) / 1000;
    if (pos >= this.buffer.duration - 0.03) { onEnded && onEnded(); return; }

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.graph.input);
    src.onended = () => {
      if (this.source === src) { this.source = null; this.anchor = null; onEnded && onEnded(); }
    };

    const want = this.scheduleAt(target) + this.trim / 1000;
    const when = Math.max(this.ctx.currentTime + 0.005, want);
    if (when - want > 0.002) this.lateStarts++;      // we missed the window: buffer too short
    src.start(when, Math.max(0, pos));
    this.source = src;
    this.rate = 1;
    this.anchor = { x: when, pos };      // at ctx time `when`, `pos` becomes audible
  },

  /**
   * Compare the position we should be at with the position we are at, both read
   * at the same instant, then bend playbackRate to close the gap. A few tenths of
   * a percent is inaudible; Snapcast does the same thing by inserting/dropping samples.
   */
  correct(targetPosAtServerTime) {
    if (!this.source || !this.anchor) return 0;
    const { c, p } = this.audibleNow();
    if (c < this.anchor.x) {
      if (this.anchor.x - c < 5) { this.lastError = 0; return 0; }   // genuinely still in the pre-roll
      this.anchor = { x: c, pos: this.anchor.pos };                  // nonsense anchor: let the error show
    }
    const expected = targetPosAtServerTime(Clock.toServer(p)) - this.trim / 1000;
    const err = expected - this.heardPos(c);       // positive: we are running late
    this.lastError = err;

    if (Math.abs(err) > 0.25) return err;          // caller does a hard re-schedule

    let rate = 1;
    if (Math.abs(err) > 0.003) rate = clamp(1 + err * 0.6, 0.98, 1.02);
    if (Math.abs(rate - this.rate) > 0.0005) {
      const cc = this.ctx.currentTime;
      this.anchor = { x: cc, pos: this.heardPos(cc) };
      this.rate = rate;
      try { this.source.playbackRate.setValueAtTime(rate, cc); } catch {}
      if (rate !== 1) this.corrections++;
    }
    return err;
  },

  /* ── synced click track: verify alignment without needing a file ── */
  startMetronome(anchorServer, bpm) {
    this.metroOn = true; this.bpm = bpm; this.metroAnchor = anchorServer;
    const period = 60000 / bpm;
    this.beat = Math.max(0, Math.floor((Clock.now() - anchorServer) / period));
    this.pumpMetronome();
  },
  stopMetronome() { this.metroOn = false; },
  pumpMetronome() {
    if (!this.metroOn || !this.ctx) return;
    const period = 60000 / this.bpm;
    const horizon = Clock.now() + 1200;
    let guard = 0;
    while (this.metroAnchor + this.beat * period < horizon && guard++ < 64) {
      const at = this.metroAnchor + this.beat * period;
      if (at > Clock.now() - 50) this.click(at, this.beat % 4 === 0);
      this.beat++;
    }
  },
  click(serverMs, accent) {
    const when = this.scheduleAt(serverMs) + this.trim / 1000;
    this.burst(when, accent ? 1320 : 880, accent ? 0.5 : 0.28, this.graph.input);
  },
  burst(when, freq, peak, dest) {
    if (!this.ctx || when < this.ctx.currentTime + 0.002) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
    o.connect(g); g.connect(dest || this.ctx.destination);
    o.start(when); o.stop(when + 0.12);
  },

  /**
   * Mic calibration: emit a click, listen for it, and time the loop.
   * Bluetooth speakers add 150–300 ms that no network protocol can discover —
   * the same problem AV receivers solve with a calibration mic.
   */
  async calibrate(onStep) {
    if (!this.ctx || this.ctx.state !== 'running') throw new Error('Audio is not enabled yet');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('No microphone API here');
    this.calibrating = true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    try {
      if (!this._recModule) {
        const code = `
          class Rec extends AudioWorkletProcessor {
            constructor(){ super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data.on; }; }
            process(inputs) {
              const ch = inputs[0] && inputs[0][0];
              if (this.on && ch) {
                let sum = 0;
                for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
                this.port.postMessage({ t: currentTime, rms: Math.sqrt(sum / ch.length) });
              }
              return true;
            }
          }
          registerProcessor('ens-rec', Rec);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        this._recModule = true;
      }
      const src = this.ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(this.ctx, 'ens-rec');
      const sink = this.ctx.createGain(); sink.gain.value = 0;    // keep the graph pulling, stay silent
      src.connect(node); node.connect(sink); sink.connect(this.ctx.destination);

      const results = [];
      for (let round = 0; round < 3; round++) {
        onStep && onStep(`listening ${round + 1}/3`);
        const frames = [];
        node.port.onmessage = (e) => frames.push(e.data);
        node.port.postMessage({ on: true });
        await sleep(300);
        const floor = frames.length
          ? frames.map((f) => f.rms).sort((a, b) => a - b)[Math.floor(frames.length * 0.9)]
          : 0.002;
        const emitAt = this.ctx.currentTime + 0.25;
        this.burst(emitAt, 1000, 0.6, this.ctx.destination);      // straight out, bypassing channel modes
        await sleep(650);
        node.port.postMessage({ on: false });
        const thresh = Math.max(floor * 8, 0.015);
        const hit = frames.find((f) => f.t > emitAt + 0.0005 && f.rms > thresh);
        if (hit) results.push((hit.t - emitAt) * 1000);
        await sleep(150);
      }
      try { src.disconnect(); node.disconnect(); sink.disconnect(); } catch {}
      if (!results.length) throw new Error('Could not hear the click — turn the volume up');
      results.sort((a, b) => a - b);
      this.calib = Math.round(results[Math.floor(results.length / 2)]);   // median of 3
      return this.calib;
    } finally {
      this.calibrating = false;
      stream.getTracks().forEach((t) => t.stop());
    }
  },
};


