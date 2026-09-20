/* Ensemble — live streaming.
 *
 * The host captures whatever it is playing, cuts it into short chunks, and
 * stamps each one with the instant it should be heard: capture time + a fixed
 * buffer. Every device — the host included — schedules that chunk for exactly
 * that instant. Nobody plays a chunk when it arrives; they play it when the
 * clock says to, which is what keeps the room together.
 *
 * This is the same trade Snapcast makes for live sources: a few hundred ms of
 * delay, bought back as sample-level agreement between speakers.
 */
'use strict';

const LIVE_MAGIC = 0x454e534c;      // 'ENSL'
const LIVE_HEADER = 24;
/* Header: magic u32 | channels u8 | flags u8 | pad u16 | playAt f64 | rate u32 | seq u32
   Everything a listener needs is in the chunk, so a chunk that overtakes the
   'live starting' message still plays correctly. */

const Live = {
  on: false, sending: false,
  stream: null, node: null, src: null, sink: null, worklet: false,
  rate: 48000, channels: 2, bufferMs: 700, chunkFrames: 1024,
  seq: 0, epochCtx: null, player: null, playerModule: false, localAudioSuppressed: false,
  stats: { sent: 0, played: 0, late: 0, reanchors: 0, bytes: 0, lastArrival: 0, under: 0, filled: 0 },

  get ctx() { return Engine.ctx; },

  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.AudioWorkletNode);
  },

  /* ─────────────────────────────── host side ───────────────────────────── */

  /**
   * Ask for a tab or screen and take its audio. Chrome only offers the audio
   * checkbox when video is requested too, so we ask for both and drop the video.
   */
  async startCapture(opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') throw new Error('Enable audio first');
    if (this.sending) return;

    let stream;
    if (opts.testStream) stream = opts.testStream;              // used by the self-test
    else {
      if (!this.supported()) throw new Error('This browser cannot capture tab audio');
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          // Stop the captured tab playing out of this device's own speakers.
          // Without it you hear the source now and the synced room a buffer later.
          suppressLocalAudioPlayback: true,
        },
        // Chrome only offers the audio checkbox when video is asked for too,
        // and prefers the tab picker when we say so.
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
      stream.getVideoTracks().forEach((t) => t.stop());          // we only wanted the sound
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('No audio in that share — tick "Share tab audio" in the picker');
      }
      stream.getAudioTracks()[0].addEventListener('ended', () => this.stopCapture());
    }

    await this.ensureWorklet();
    this.stream = stream;
    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'ens-live', {
      processorOptions: { chunkFrames: this.chunkFrames },
      channelCount: 2, channelCountMode: 'explicit',
    });
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;                                    // pull the graph, stay silent
    this.src.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);

    this.rate = this.ctx.sampleRate;
    this.channels = 2;
    this.seq = 0;
    this.stats = { sent: 0, played: 0, late: 0, reanchors: 0, bytes: 0, lastArrival: 0 };
    this.node.port.onmessage = (e) => this.onCaptured(e.data);
    this.sending = true;

    // Did the browser honour the suppression request? Chrome 109+ does for tab
    // capture; anything else means the user has to mute the source themselves.
    const track = stream.getAudioTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    this.localAudioSuppressed = settings.suppressLocalAudioPlayback === true;

    this.announcedAt = performance.now();
    Net.send({ t: 'live', on: true, rate: this.rate, channels: this.channels, bufferMs: this.bufferMs });
    return true;
  },

  stopCapture() {
    if (!this.sending) return;
    this.sending = false;
    try { this.node && (this.node.port.onmessage = null); } catch {}
    try { this.src && this.src.disconnect(); this.node && this.node.disconnect(); this.sink && this.sink.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    this.src = this.node = this.sink = this.stream = null;
    Net.send({ t: 'live', on: false });
  },

  async ensureWorklet() {
    if (this.worklet) return;
    const code = `
      class LiveCap extends AudioWorkletProcessor {
        constructor(o) {
          super();
          this.n = (o.processorOptions && o.processorOptions.chunkFrames) || 1024;
          this.l = new Float32Array(this.n);
          this.r = new Float32Array(this.n);
          this.used = 0;
          this.startTime = 0;
        }
        process(inputs) {
          const inp = inputs[0];
          if (!inp || !inp[0]) return true;
          const l = inp[0], r = inp[1] || inp[0];
          let off = 0;
          while (off < l.length) {
            if (this.used === 0) {
              // contextTime of the first frame in this chunk
              this.startTime = currentTime + off / sampleRate;
            }
            const take = Math.min(this.n - this.used, l.length - off);
            this.l.set(l.subarray(off, off + take), this.used);
            this.r.set(r.subarray(off, off + take), this.used);
            this.used += take;
            off += take;
            if (this.used === this.n) {
              this.port.postMessage(
                { t: this.startTime, l: this.l, r: this.r },
                [this.l.buffer, this.r.buffer]);
              this.l = new Float32Array(this.n);
              this.r = new Float32Array(this.n);
              this.used = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('ens-live', LiveCap);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.worklet = true;
  },

  /** Pack one captured chunk and hand it to the room. */
  onCaptured(chunk) {
    if (!this.sending) return;
    const frames = chunk.l.length;
    const playAt = Engine.serverTimeOfCtx(chunk.t) + this.bufferMs;

    const buf = new ArrayBuffer(LIVE_HEADER + frames * this.channels * 2);
    const view = new DataView(buf);
    view.setUint32(0, LIVE_MAGIC);
    view.setUint8(4, this.channels);
    view.setUint8(5, 0);
    view.setUint16(6, 0);
    view.setFloat64(8, playAt);
    view.setUint32(16, this.rate);
    view.setUint32(20, this.seq + 1);
    const pcm = new Int16Array(buf, LIVE_HEADER);
    for (let i = 0; i < frames; i++) {                 // float → interleaved int16
      const a = Math.max(-1, Math.min(1, chunk.l[i]));
      const b = Math.max(-1, Math.min(1, chunk.r[i]));
      pcm[i * 2] = a < 0 ? a * 0x8000 : a * 0x7fff;
      pcm[i * 2 + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
    }

    this.seq++;
    this.stats.sent++;
    this.stats.bytes += buf.byteLength;
    Net.broadcastBinary(buf);
    this.enqueue(buf);                                  // the host is a speaker too
  },

  /* ────────────────────────────── listener side ────────────────────────── */

  /*
   * Playback is a reader over a timeline, not a queue of scheduled buffers.
   * Incoming PCM lands in a ring buffer indexed by its absolute position in the
   * stream; an AudioWorklet works out, for every single output sample, where
   * the room clock says the stream should be and interpolates there.
   *
   * That does three things a chunk-per-chunk scheduler cannot: it resamples
   * continuously (the host may run at 44.1 kHz while this device runs at 48),
   * it absorbs clock drift smoothly instead of jumping when it accumulates,
   * and a missing chunk costs silence rather than the anchor.
   */
  async ensurePlayer() {
    if (this.player || !window.AudioWorkletNode) return this.player;
    if (!this.playerModule) {
      const code = `
        class LivePlay extends AudioWorkletProcessor {
          constructor(o) {
            super();
            this.size = o.processorOptions.size;
            this.l = new Float32Array(this.size);
            this.r = new Float32Array(this.size);
            this.maxIdx = -1; this.minIdx = 0;
            this.epoch = 0; this.rate = 48000; this.have = false;
            this.under = 0; this.filled = 0; this.tick = 0;
            this.port.onmessage = (e) => {
              const d = e.data;
              if (d.reset) { this.maxIdx = -1; this.minIdx = 0; this.have = false; }
              if (d.epoch !== undefined) { this.epoch = d.epoch; this.rate = d.rate; this.have = true; }
              if (d.l) this.write(d.idx, d.l, d.r);
            };
          }
          write(idx, l, r) {
            const n = l.length, size = this.size;
            for (let i = 0; i < n; i++) {
              let p = (idx + i) % size; if (p < 0) p += size;
              this.l[p] = l[i]; this.r[p] = r[i];
            }
            const last = idx + n - 1;
            if (last > this.maxIdx) this.maxIdx = last;
            this.minIdx = Math.max(this.minIdx, this.maxIdx - size + 1);
          }
          process(_, outputs) {
            const out = outputs[0];
            const L = out[0], R = out[1] || out[0];
            const n = L.length;
            if (!this.have) { L.fill(0); if (R !== L) R.fill(0); return true; }
            const size = this.size;
            for (let i = 0; i < n; i++) {
              const pos = (currentTime + i / sampleRate - this.epoch) * this.rate;
              const i0 = Math.floor(pos), f = pos - i0;
              if (i0 < this.minIdx || i0 + 1 > this.maxIdx) {
                L[i] = 0; if (R !== L) R[i] = 0;
                if (this.filled) this.under++;      // silence before the first sample is the buffer filling, not a gap
                continue;
              }
              let a = i0 % size; if (a < 0) a += size;
              let b = (i0 + 1) % size; if (b < 0) b += size;
              L[i] = this.l[a] * (1 - f) + this.l[b] * f;
              if (R !== L) R[i] = this.r[a] * (1 - f) + this.r[b] * f;
              this.filled++;
            }
            if (++this.tick % 40 === 0) {
              this.port.postMessage({ under: this.under, filled: this.filled, ahead: this.maxIdx });
            }
            return true;
          }
        }
        registerProcessor('ens-play', LivePlay);`;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.playerModule = true;
    }
    const size = Math.ceil(this.ctx.sampleRate * 4) * 2;      // ~8 s of slack
    this.player = new AudioWorkletNode(this.ctx, 'ens-play', {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { size },
    });
    this.player.port.onmessage = (e) => {
      this.stats.under = e.data.under;
      this.stats.filled = e.data.filled;
    };
    this.connectPlayer();
    return this.player;
  },

  /** Re-attached whenever the channel-mode graph is rebuilt. */
  connectPlayer() {
    if (!this.player || !Engine.graph) return;
    try { this.player.disconnect(); } catch {}
    this.player.connect(Engine.graph.input);
  },

  begin(meta) {
    this.on = true;
    this.rate = meta.rate || 48000;
    this.channels = meta.channels || 2;
    this.bufferMs = meta.bufferMs || 700;
    this.epochCtx = null;
    this.stats.played = this.stats.late = this.stats.reanchors = 0;
    this.ensurePlayer().catch(() => {});
  },

  end() {
    this.on = false;
    this.epochCtx = null;
    if (this.player) { try { this.player.port.postMessage({ reset: true }); } catch {} }
  },

  /** Place one arriving chunk on the timeline. */
  enqueue(buf) {
    if (!this.ctx || this.ctx.state !== 'running' || !Engine.graph) return;
    const view = new DataView(buf);
    if (view.getUint32(0) !== LIVE_MAGIC) return;
    const channels = view.getUint8(4) || 2;
    const playAt = view.getFloat64(8);
    const rate = view.getUint32(16) || this.rate;
    const seq = view.getUint32(20);
    const pcm = new Int16Array(buf, LIVE_HEADER);
    const frames = pcm.length / channels;
    if (!frames) return;

    this.rate = rate;
    this.on = true;
    this.stats.lastArrival = performance.now();
    this.stats.played++;

    if (!this.player) { this.ensurePlayer().catch(() => {}); if (!this.player) return; }

    const idx = (seq - 1) * frames;                 // absolute position in the stream
    const trimSec = Engine.trim / 1000;
    const wantEpoch = Engine.scheduleAt(playAt) + trimSec - idx / rate;
    if (this.epochCtx === null || Math.abs(wantEpoch - this.epochCtx) > 0.05) {
      if (this.epochCtx !== null) this.stats.reanchors++;
      this.epochCtx = wantEpoch;
      this.player.port.postMessage({ epoch: this.epochCtx, rate });
    }

    const l = new Float32Array(frames), r = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      l[i] = pcm[i * channels] / 0x8000;
      r[i] = pcm[i * channels + (channels > 1 ? 1 : 0)] / 0x8000;
    }
    this.player.port.postMessage({ idx, l, r }, [l.buffer, r.buffer]);
  },

  diagnostics() {
    return {
      on: this.on, sending: this.sending, bufferMs: this.bufferMs,
      rate: this.rate, chunkMs: +(this.chunkFrames / this.rate * 1000).toFixed(1),
      sent: this.stats.sent, played: this.stats.played,
      late: this.stats.late, reanchors: this.stats.reanchors,
      gapPct: this.stats.filled ? +((this.stats.under / (this.stats.under + this.stats.filled)) * 100).toFixed(2) : 0,
      suppressed: this.localAudioSuppressed,
      kbps: +((this.stats.bytes * 8) / 1000 / Math.max(1, this.stats.sent * this.chunkFrames / this.rate)).toFixed(0),
    };
  },
};
