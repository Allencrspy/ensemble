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
const LIVE_HEADER = 32;
/* Header: magic u32 | flags u8 | hops u8 | pad u16 | playAt f64 | rate u32 | seq u32 | ts f64
   flags: bit0 codec (0 = PCM s16, 1 = Opus), bits 4-7 channel count.
   Everything a listener needs is in the chunk, so one that overtakes the
   'live starting' message still plays correctly — and so any node can relay a
   chunk onward without understanding or re-timing it. */
const FLAG_OPUS = 1;
const OPUS_BITRATE = 128000;

const Live = {
  on: false, sending: false,
  stream: null, node: null, src: null, sink: null, worklet: false,
  rate: 48000, captureRate: 48000, channels: 2, bufferMs: 700, chunkFrames: 1024,
  seq: 0, epochCtx: null, player: null, playerModule: false, localAudioSuppressed: false,
  encoder: null, decoder: null, codec: 'pcm', streamFrames: 0, epochServer: 0, pending: [],
  seen: new Set(), epochTarget: null, warmup: [], slackWindow: [], frameMs: 20,
  stats: { sent: 0, played: 0, placed: 0, late: 0, reanchors: 0, bytes: 0,
           lastArrival: 0, under: 0, filled: 0, decodeErrors: 0, copyErrors: 0, hops: 0, dupes: 0 },
  codecSeen: null,

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

    this.captureRate = this.ctx.sampleRate;     // never touched by playback
    this.rate = this.captureRate;
    this.frameMs = Mesh.frameMsFor(App.room ? App.room.devices.length : 2, 0.15, this.captureRate);
    this.chunkFrames = Math.max(64, Math.round((this.captureRate * this.frameMs) / 1000));
    this.channels = 2;
    this.seq = 0;
    this.streamFrames = 0;
    this.epochServer = 0;
    await this.setupCodec();
    Object.assign(this.stats, { sent: 0, played: 0, placed: 0, late: 0, reanchors: 0, bytes: 0, dupes: 0 });
    this.slackWindow.length = 0;
    this.node.port.onmessage = (e) => this.onCaptured(e.data);
    this.sending = true;

    // Did the browser honour the suppression request? Chrome 109+ does for tab
    // capture; anything else means the user has to mute the source themselves.
    const track = stream.getAudioTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    this.localAudioSuppressed = settings.suppressLocalAudioPlayback === true;

    this.announcedAt = performance.now();
    Net.send({ t: 'live', on: true, rate: this.rate, channels: this.channels, bufferMs: this.bufferMs, codec: this.codec });
    return true;
  },

  stopCapture() {
    if (!this.sending) return;
    this.sending = false;
    try { this.node && (this.node.port.onmessage = null); } catch {}
    try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch {}
    this.encoder = null;
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
          this.port.onmessage = (e) => {
            if (!e.data || !e.data.chunk) return;
            this.n = e.data.chunk;                 // retune: next chunk uses the new size
            this.l = new Float32Array(this.n);
            this.r = new Float32Array(this.n);
            this.used = 0;
          };
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

  /** Opus where the browser has WebCodecs, raw PCM where it does not. */
  async setupCodec() {
    this.codec = 'pcm';
    if (!window.AudioEncoder) return;
    const config = {
      codec: 'opus', sampleRate: this.captureRate, numberOfChannels: 2,
      bitrate: OPUS_BITRATE, opus: { frameDuration: this.frameMs * 1000 },
    };
    try {
      const probe = await AudioEncoder.isConfigSupported(config);
      if (!probe.supported) return;
      this.encoder = new AudioEncoder({
        output: (chunk) => this.onEncoded(chunk),
        error: (e) => {                            // fall back rather than go silent
          this.codec = 'pcm';
          this.codecError = (e && e.message) || 'encoder error';
        },
      });
      this.encoder.configure(config);
      this.codec = 'opus';
    } catch (e) {
      this.codec = 'pcm';
      this.codecError = (e && e.message) || 'configure failed';
    }
  },

  /** Pack one captured chunk and hand it to the room. */
  onCaptured(chunk) {
    if (!this.sending) return;
    const frames = chunk.l.length;

    if (this.codec === 'opus' && this.encoder && this.encoder.state === 'configured') {
      const tsUs = Math.round((this.streamFrames / this.captureRate) * 1e6);
      // Anchor the stream's timeline to measured capture time, and keep nudging
      // it. Any residual slip between the encoder's clock and the room's clock
      // would otherwise eat the buffer a few milliseconds every second.
      const anchor = Engine.serverTimeOfCtx(chunk.t) - tsUs / 1000;
      if (!this.epochServer) this.epochServer = anchor;
      else this.epochServer += (anchor - this.epochServer) * 0.02;
      const planar = new Float32Array(frames * 2);
      planar.set(chunk.l, 0);
      planar.set(chunk.r, frames);
      try {
        this.encoder.encode(new AudioData({
          format: 'f32-planar', sampleRate: this.captureRate, numberOfFrames: frames,
          numberOfChannels: 2, timestamp: tsUs, data: planar,
        }));
      } catch (e) {
        this.codec = 'pcm';
        this.codecError = (e && e.message) || 'encode threw';
      }
      this.streamFrames += frames;
      return;
    }

    const playAt = Engine.serverTimeOfCtx(chunk.t) + this.bufferMs;

    const buf = new ArrayBuffer(LIVE_HEADER + frames * this.channels * 2);
    const view = new DataView(buf);
    view.setUint32(0, LIVE_MAGIC);
    view.setUint8(4, (this.channels << 4));            // PCM
    view.setUint8(5, 0);
    view.setUint16(6, 0);
    view.setFloat64(8, playAt);
    view.setUint32(16, this.captureRate);
    view.setUint32(20, this.seq + 1);
    view.setFloat64(24, (this.streamFrames / this.captureRate) * 1e6);
    this.streamFrames += frames;
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

  /** An encoded Opus packet, wrapped with the timing every listener needs. */
  onEncoded(encoded) {
    if (!this.sending) return;
    const payload = new Uint8Array(encoded.byteLength);
    encoded.copyTo(payload);
    const tsUs = encoded.timestamp;
    const playAt = this.epochServer + tsUs / 1000 + this.bufferMs;

    const buf = new ArrayBuffer(LIVE_HEADER + payload.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, LIVE_MAGIC);
    view.setUint8(4, (this.channels << 4) | FLAG_OPUS);
    view.setUint8(5, 0);
    view.setUint16(6, 0);
    view.setFloat64(8, playAt);
    view.setUint32(16, this.captureRate);
    view.setUint32(20, ++this.seq);
    view.setFloat64(24, tsUs);
    new Uint8Array(buf, LIVE_HEADER).set(payload);

    this.stats.sent++;
    this.stats.bytes += buf.byteLength;
    Net.broadcastBinary(buf);
    this.enqueue(buf);
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
    this.epochTarget = null;
    this.warmup.length = 0;
    this.stats.played = this.stats.placed = this.stats.late = this.stats.reanchors = 0;
    this.stats.decodeErrors = 0;
    this.ensurePlayer().catch((e) => { this.lastDecodeError = 'player: ' + (e && e.message); });
  },

  end() {
    this.on = false;
    this.epochCtx = null;
    this.epochTarget = null;
    this.warmup.length = 0;
    this.seen.clear();
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.decoder = null;
    this.pending.length = 0;
    if (this.player) { try { this.player.port.postMessage({ reset: true }); } catch {} }
  },

  /** Place one arriving chunk on the timeline, then pass it down the tree. */
  enqueue(buf, fromNetwork) {
    if (!this.ctx || this.ctx.state !== 'running' || !Engine.graph) return;
    const view = new DataView(buf);
    if (view.getUint32(0) !== LIVE_MAGIC) return;

    const flags = view.getUint8(4);
    const isOpus = (flags & FLAG_OPUS) !== 0;
    const channels = (flags >> 4) || 2;
    const playAt = view.getFloat64(8);
    const rate = view.getUint32(16) || this.rate;
    const seq = view.getUint32(20);
    const tsUs = view.getFloat64(24);

    // Deduplicate first. With two paths feeding us, relaying before this check
    // would double the traffic of everything below us.
    if (this.seen.has(seq)) { this.stats.dupes++; return; }
    this.seen.add(seq);

    // How much margin this chunk had. This is the measurement the whole
    // latency budget is built on: the buffer only needs to cover the worst of it.
    const slack = playAt - Clock.now();
    this.slackWindow.push(slack);
    if (this.slackWindow.length > 128) this.slackWindow.shift();

    // Relay onward before decoding: a child's buffer should not wait on our CPU.
    // The chunk is unchanged, timestamps included, so the hop stays invisible.
    if (fromNetwork) {
      const onward = buf.slice(0);
      new DataView(onward).setUint8(5, Math.min(255, view.getUint8(5) + 1));
      Net.relayAudio(onward);
      this.stats.hops = view.getUint8(5);
    }
    if (this.seen.size > 512) { const it = this.seen.values(); for (let i = 0; i < 128; i++) this.seen.delete(it.next().value); }

    this.rate = rate;
    this.on = true;
    this.stats.lastArrival = performance.now();
    this.stats.played++;
    if (!this.player) { this.ensurePlayer().catch(() => {}); if (!this.player) return; }

    this.codecSeen = isOpus ? 'opus' : 'pcm';
    if (isOpus) { this.decodeOpus(buf, playAt, tsUs, rate); return; }

    const pcm = new Int16Array(buf, LIVE_HEADER);
    const frames = pcm.length / channels;
    if (!frames) return;
    const l = new Float32Array(frames), r = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      l[i] = pcm[i * channels] / 0x8000;
      r[i] = pcm[i * channels + (channels > 1 ? 1 : 0)] / 0x8000;
    }
    this.place(tsUs, playAt, rate, l, r);
  },

  async decodeOpus(buf, playAt, tsUs, rate) {
    if (!window.AudioDecoder) return;
    if (!this.decoder) {
      try {
        this.decoder = new AudioDecoder({
          output: (data) => this.onDecoded(data),
          error: (e) => {
            this.stats.decodeErrors++;
            this.lastDecodeError = e && e.message;
            try { this.decoder.close(); } catch {}
            this.decoder = null;
          },
        });
        // Opus is a 48 kHz codec whatever went in. Configuring the decoder at
        // the host's input rate produced no output and no error at all.
        this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      } catch { this.decoder = null; return; }
    }
    this.pending.push({ tsUs, playAt });
    if (this.pending.length > 64) this.pending.shift();
    try {
      this.decoder.decode(new EncodedAudioChunk({
        type: 'key', timestamp: tsUs,
        data: new Uint8Array(buf, LIVE_HEADER),
      }));
    } catch (e) {
      this.stats.decodeErrors++;
      this.lastDecodeError = e && e.message;    // one bad packet is silence, not a failure
    }
  },

  /** Opus gives frames back in order, so the timing queue pairs by arrival. */
  onDecoded(data) {
    const match = this.pending.shift();
    const frames = data.numberOfFrames;
    const ch = data.numberOfChannels;
    const rate = data.sampleRate;
    const tsUs = data.timestamp;
    const l = new Float32Array(frames), r = new Float32Array(frames);
    let ok = false;

    // Chromium's Opus decoder returns interleaved f32, not planes. Ask for the
    // planar conversion, and de-interleave by hand if it will not do it.
    try {
      data.copyTo(l, { planeIndex: 0, format: 'f32-planar' });
      data.copyTo(r, { planeIndex: ch > 1 ? 1 : 0, format: 'f32-planar' });
      ok = true;
    } catch {
      try {
        const inter = new Float32Array(frames * ch);
        data.copyTo(inter, { planeIndex: 0 });
        for (let i = 0; i < frames; i++) {
          l[i] = inter[i * ch];
          r[i] = inter[i * ch + (ch > 1 ? 1 : 0)];
        }
        ok = true;
      } catch (e) {
        this.stats.copyErrors++;
        this.lastDecodeError = 'copyTo: ' + (e && e.message);
      }
    }
    data.close();
    if (!ok || !match) return;
    this.place(tsUs, match.playAt + (tsUs - match.tsUs) / 1000, rate, l, r);
  },

  /**
   * Drop decoded audio onto the shared timeline.
   *
   * The epoch — the context time at which stream timestamp zero is heard — is
   * not set once and trusted. A device that anchors while its clock estimate is
   * still settling would keep that error for the whole session, which is
   * exactly what left listeners tens of milliseconds behind the host. So the
   * epoch is steered continuously toward where the room clock says it belongs,
   * at a rate slow enough to be inaudible (0.25%, about 4 cents), with a hard
   * re-anchor reserved for a genuine break.
   */
  place(tsUs, playAt, rate, l, r) {
    if (!this.player) return;
    this.stats.placed++;
    this.rate = rate;

    const want = Engine.scheduleAt(playAt) + Engine.trim / 1000 - tsUs / 1e6;

    // Anchoring off a single chunk bakes in whatever the clock estimate happened
    // to be at that instant, and the slew then takes ten seconds to work it off.
    // Spend the first ~250 ms of the buffer collecting candidates and take the
    // median instead; it costs nothing visible and starts us within a millisecond.
    if (this.epochCtx === null) {
      this.warmup.push(want);
      if (this.warmup.length < 12) return;
      const sorted = [...this.warmup].sort((a, b) => a - b);
      this.epochCtx = this.epochTarget = sorted[Math.floor(sorted.length / 2)];
      this.warmup.length = 0;
      this.player.port.postMessage({ epoch: this.epochCtx, rate });
    } else if (Math.abs(want - this.epochCtx) > 0.05) {
      if (this.epochCtx !== null) this.stats.reanchors++;
      this.epochCtx = want;
      this.epochTarget = want;
      this.player.port.postMessage({ epoch: this.epochCtx, rate });
    } else {
      // Smooth the target: single chunks carry network and timestamp jitter.
      this.epochTarget = this.epochTarget === null
        ? want : this.epochTarget + (want - this.epochTarget) * 0.08;
      const err = this.epochTarget - this.epochCtx;
      this.stats.errMs = err * 1000;
      const maxStep = 0.004 * (l.length / rate);         // 0.4% of real time, ~7 cents
      const step = clamp(err, -maxStep, maxStep);
      if (Math.abs(step) > 1e-7) {
        this.epochCtx += step;
        this.player.port.postMessage({ epoch: this.epochCtx, rate });
      }
    }

    const idx = Math.round((tsUs / 1e6) * rate);
    this.player.port.postMessage({ idx, l, r }, [l.buffer, r.buffer]);
  },

  /** Worst margin seen recently: what the buffer actually has to cover. */
  slackMs() {
    if (!this.slackWindow.length) return null;
    return Math.round(Math.min(...this.slackWindow));
  },

  /**
   * Change the frame size without dropping the stream. Shorter frames mean
   * lower latency and more packets; the host picks from the room's size.
   */
  async retune(frameMs) {
    if (!this.sending || frameMs === this.frameMs) return;
    this.frameMs = frameMs;
    const frames = Math.max(64, Math.round((this.captureRate * frameMs) / 1000));
    this.chunkFrames = frames;
    try { this.node && this.node.port.postMessage({ chunk: frames }); } catch {}
    if (this.codec === 'opus' && this.encoder && this.encoder.state === 'configured') {
      try {
        this.encoder.configure({
          codec: 'opus', sampleRate: this.captureRate, numberOfChannels: 2,
          bitrate: OPUS_BITRATE, opus: { frameDuration: frameMs * 1000 },
        });
      } catch (e) { this.codecError = 'retune: ' + (e && e.message); }
    }
  },

  diagnostics() {
    return {
      on: this.on, sending: this.sending, bufferMs: this.bufferMs,
      codec: this.sending ? this.codec : (this.codecSeen || '—'),
      hops: this.stats.hops || 0,
      placed: this.stats.placed, decodeErrors: this.stats.decodeErrors,
      copyErrors: this.stats.copyErrors,
      errMs: +(this.stats.errMs || 0).toFixed(2),
      codecError: this.codecError || null,
      frameMs: this.frameMs, slackMs: this.slackMs(), dupes: this.stats.dupes,
      lastDecodeError: this.lastDecodeError || null,
      rate: this.rate, captureRate: this.captureRate,
      chunkMs: +(this.chunkFrames / this.captureRate * 1000).toFixed(1),
      sent: this.stats.sent, played: this.stats.played,
      late: this.stats.late, reanchors: this.stats.reanchors,
      gapPct: this.stats.filled ? +((this.stats.under / (this.stats.under + this.stats.filled)) * 100).toFixed(2) : 0,
      suppressed: this.localAudioSuppressed,
      kbps: +((this.stats.bytes * 8) / 1000 / Math.max(1, this.stats.sent * this.chunkFrames / this.rate)).toFixed(0),
    };
  },
};
