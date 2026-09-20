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
  seq: 0, nextCtx: 0, anchored: false,
  stats: { sent: 0, played: 0, late: 0, reanchors: 0, bytes: 0, lastArrival: 0 },

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
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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

  begin(meta) {
    this.on = true;
    this.rate = meta.rate || 48000;
    this.channels = meta.channels || 2;
    this.bufferMs = meta.bufferMs || 700;
    this.anchored = false;
    this.stats.played = this.stats.late = this.stats.reanchors = 0;
  },

  end() {
    this.on = false;
    this.anchored = false;
  },

  /** Schedule one arriving chunk at the instant its timestamp names. */
  enqueue(buf) {
    if (!this.ctx || this.ctx.state !== 'running' || !Engine.graph) return;
    const view = new DataView(buf);
    if (view.getUint32(0) !== LIVE_MAGIC) return;
    const channels = view.getUint8(4) || 2;
    const playAt = view.getFloat64(8);
    const rate = view.getUint32(16) || this.rate;
    const pcm = new Int16Array(buf, LIVE_HEADER);
    const frames = pcm.length / channels;
    if (!frames) return;
    this.rate = rate;               // the chunk is authoritative, not the announcement
    this.on = true;

    this.stats.lastArrival = performance.now();
    const dur = frames / rate;
    const target = Engine.scheduleAt(playAt) + Engine.trim / 1000;

    // Run a contiguous cursor rather than trusting each chunk's own mapping:
    // per-chunk jitter would put audible seams between them.
    if (!this.anchored || Math.abs(target - this.nextCtx) > 0.03) {
      if (this.anchored) this.stats.reanchors++;
      this.nextCtx = target;
      this.anchored = true;
    }
    const when = this.nextCtx;
    this.nextCtx += dur;

    if (when < this.ctx.currentTime + 0.005) {          // arrived too late to be useful
      this.stats.late++;
      this.anchored = false;
      return;
    }

    const ab = this.ctx.createBuffer(2, frames, rate);
    const L = ab.getChannelData(0), R = ab.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      L[i] = pcm[i * channels] / 0x8000;
      R[i] = pcm[i * channels + (channels > 1 ? 1 : 0)] / 0x8000;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(Engine.graph.input);                    // channel modes and volume still apply
    src.start(when);
    this.stats.played++;
  },

  diagnostics() {
    return {
      on: this.on, sending: this.sending, bufferMs: this.bufferMs,
      rate: this.rate, chunkMs: +(this.chunkFrames / this.rate * 1000).toFixed(1),
      sent: this.stats.sent, played: this.stats.played,
      late: this.stats.late, reanchors: this.stats.reanchors,
      kbps: +((this.stats.bytes * 8) / 1000 / Math.max(1, this.stats.sent * this.chunkFrames / this.rate)).toFixed(0),
    };
  },
};
