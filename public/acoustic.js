/* Ensemble — acoustics.
 *
 * Every device can emit a short chirp at an agreed instant and hear the chirps
 * of the others. Two measurements come out of that:
 *
 *   self loop  L_i  — how long this device takes to get a sound out of its own
 *                     speaker and back in through its own mic (the Bluetooth tax)
 *   cross      dt_ij — i emits at the agreed time, j hears it dt later
 *
 * Because dt_ij + dt_ji = L_i + L_j + 2·distance/speedOfSound, every unknown
 * per-device constant cancels and the distance falls out. That matrix of
 * distances is what position.js turns into a room map.
 */
'use strict';

const SPEED_OF_SOUND = 343;     // m/s at ~20 °C

const Acoustic = {
  worklet: null, stream: null, node: null, src: null, sink: null,
  capturing: null, template: null, chirpBuf: null, busy: false,

  get ctx() { return Engine.ctx; },
  get rate() { return this.ctx ? this.ctx.sampleRate : 48000; },

  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      window.AudioWorkletNode && window.isSecureContext);
  },

  /** Why the mic is unavailable, in words a person can act on. */
  unsupportedReason() {
    if (!window.isSecureContext) return 'Needs HTTPS — open the hosted build, not the plain-http LAN address';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'No microphone API in this browser';
    if (!window.AudioWorkletNode) return 'No AudioWorklet in this browser';
    return 'Unavailable';
  },

  /* ── capture plumbing ── */

  async open() {
    if (!this.ctx || this.ctx.state !== 'running') throw new Error('Enable audio first');
    if (this.node) return;
    if (!this.supported()) throw new Error(this.unsupportedReason());

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });

    if (!this.worklet) {
      const code = `
        class Cap extends AudioWorkletProcessor {
          constructor(){ super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data.on; }; }
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (this.on && ch) this.port.postMessage({ t: currentTime, d: new Float32Array(ch) });
            return true;
          }
        }
        registerProcessor('ens-cap', Cap);`;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.worklet = true;
    }

    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'ens-cap');
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;                       // pull the graph without making noise
    this.src.connect(this.node); this.node.connect(this.sink); this.sink.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.onFrame(e.data);
  },

  close() {
    try { this.node && this.node.port.postMessage({ on: false }); } catch {}
    try { this.src && this.src.disconnect(); this.node && this.node.disconnect(); this.sink && this.sink.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    this.src = this.node = this.sink = this.stream = null;
  },

  onFrame(f) {
    const cap = this.capturing;
    if (!cap) return;
    if (cap.startCtx == null) cap.startCtx = f.t;
    if (cap.used + f.d.length <= cap.buf.length) {
      cap.buf.set(f.d, cap.used);
      cap.used += f.d.length;
    }
    if (cap.used >= cap.buf.length) this.finishCapture();
  },

  finishCapture() {
    const cap = this.capturing;
    if (!cap) return;
    this.capturing = null;
    this.node && this.node.port.postMessage({ on: false });
    cap.resolve({ samples: cap.buf.subarray(0, cap.used), startCtx: cap.startCtx, rate: this.rate });
  },

  /** Record a window of microphone audio, tagged with its context-time origin. */
  async record(ms) {
    await this.open();
    const n = Math.ceil((ms / 1000) * this.rate);
    return new Promise((resolve) => {
      this.capturing = { buf: new Float32Array(n), used: 0, startCtx: null, resolve };
      this.node.port.postMessage({ on: true });
      setTimeout(() => { if (this.capturing) this.finishCapture(); }, ms + 400);
    });
  },

  /* ── the chirp ── */

  /** 24 ms linear sweep, 2 → 6 kHz, Hann-windowed: loud, short, and easy to find. */
  buildChirp() {
    if (this.chirpBuf && this.chirpBuf.sampleRate === this.rate) return;
    const rate = this.rate;
    const dur = 0.024;
    const n = Math.round(dur * rate);
    const buf = this.ctx.createBuffer(1, n, rate);
    const d = buf.getChannelData(0);
    const f0 = 2000, f1 = 6000;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * dur)) * t * t);
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      d[i] = Math.sin(phase) * win;
    }
    this.chirpBuf = buf;
    const tpl = new Float32Array(d);                 // zero-mean template for matching
    let mean = 0; for (let i = 0; i < tpl.length; i++) mean += tpl[i];
    mean /= tpl.length;
    let energy = 0;
    for (let i = 0; i < tpl.length; i++) { tpl[i] -= mean; energy += tpl[i] * tpl[i]; }
    this.template = tpl;
    this.templateEnergy = Math.sqrt(energy) || 1;
  },

  /** Emit the chirp so it is audible at `serverMs`. Straight to the output. */
  emitAt(serverMs, gain = 0.85) {
    this.buildChirp();
    const when = Engine.scheduleAt(serverMs);
    if (when < this.ctx.currentTime + 0.002) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = this.chirpBuf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.ctx.destination);   // bypass channel modes and volume
    src.start(when);
    return true;
  },

  /** Context time ↔ server time, using the same mapping playback uses. */
  serverTimeOfCtx(ctxTime) {
    const { c, p } = Engine.audibleNow();
    return Clock.toServer(p + (ctxTime - c) * 1000);
  },

  /**
   * Matched filter: slide the known chirp over the recording and take the peak.
   * Returns the context time of the chirp's start, plus how far the peak stands
   * above the background (anything under ~4 is noise, not a chirp).
   */
  detect(rec, notBeforeCtx) {
    this.buildChirp();
    const { samples, startCtx, rate } = rec;
    const tpl = this.template, m = tpl.length;
    const from = notBeforeCtx != null ? Math.max(0, Math.floor((notBeforeCtx - startCtx) * rate)) : 0;
    const last = samples.length - m;
    if (last <= from) return null;

    let best = -Infinity, bestIdx = -1;
    let sum = 0, count = 0;
    for (let i = from; i < last; i += 1) {
      let acc = 0;
      for (let k = 0; k < m; k += 2) acc += samples[i + k] * tpl[k];   // 2× decimated: plenty for a peak
      const v = Math.abs(acc);
      sum += v; count++;
      if (v > best) { best = v; bestIdx = i; }
    }
    if (bestIdx < 0 || !count) return null;
    const mean = sum / count;
    const conf = mean > 0 ? best / mean : 0;

    // Parabolic interpolation around the peak for sub-sample timing.
    const at = (i) => {
      let acc = 0;
      for (let k = 0; k < m; k += 2) acc += samples[i + k] * tpl[k];
      return Math.abs(acc);
    };
    let frac = 0;
    if (bestIdx > from && bestIdx < last - 1) {
      const y0 = at(bestIdx - 1), y1 = best, y2 = at(bestIdx + 1);
      const den = y0 - 2 * y1 + y2;
      if (den !== 0) frac = clamp(0.5 * (y0 - y2) / den, -1, 1);
    }
    return { ctxTime: startCtx + (bestIdx + frac) / rate, conf };
  },

  /**
   * Self loop: emit and hear yourself. Everything between the scheduled instant
   * and the microphone — output buffering, Bluetooth, the mic path — lands here.
   */
  async selfLoop(rounds = 3, onStep) {
    if (this.busy) throw new Error('A measurement is already running');
    this.busy = true;
    try {
      await this.open();
      const out = [];
      for (let r = 0; r < rounds; r++) {
        onStep && onStep(`listening ${r + 1}/${rounds}`);
        const at = Clock.now() + 450;
        const recording = this.record(900);
        await sleep(60);
        if (!this.emitAt(at)) continue;
        const rec = await recording;
        const hit = this.detect(rec, Engine.scheduleAt(at) - 0.02);
        if (hit && hit.conf > 3.5) out.push(this.serverTimeOfCtx(hit.ctxTime) - at);
        await sleep(120);
      }
      if (!out.length) throw new Error('Could not hear the chirp — raise the volume');
      out.sort((a, b) => a - b);
      return Math.round(out[Math.floor(out.length / 2)] * 10) / 10;    // median, ms
    } finally { this.busy = false; }
  },

  /**
   * Listen for one scheduled chirp from another device and report how late it
   * arrived, relative to the instant the room agreed on.
   */
  async listenFor(atServerMs, windowMs = 800) {
    await this.open();
    const lead = Math.max(0, atServerMs - Clock.now() - 120);
    if (lead > 0) await sleep(lead);
    const rec = await this.record(windowMs);
    const hit = this.detect(rec, Engine.scheduleAt(atServerMs) - 0.05);
    if (!hit || hit.conf < 3.5) return null;
    return { dt: this.serverTimeOfCtx(hit.ctxTime) - atServerMs, conf: +hit.conf.toFixed(1) };
  },
};
