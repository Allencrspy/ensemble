# Ensemble

Play one track on every device in the room, locked to the same millisecond.
One device hosts, the others scan a QR code, and each becomes a speaker — a
stereo pair, a 5.1 layout, or a wall of mono.

No build step, no framework, nothing to install. Two vendored MIT libraries —
[PeerJS](https://peerjs.com) for the WebRTC handshake and
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — are the
only third-party code, and they sit in `public/vendor/`.

## Running it

**Hosted (GitHub Pages).** The whole app is static, so it can live on Pages.
There is no server, so the host's own tab holds the room and every other device
connects to it directly over WebRTC. Push this repo and turn Pages on:

```bash
git push -u origin main
```

Then **Settings → Pages → Source → GitHub Actions**. The included workflow
publishes `public/` on every push to `main`, and the app goes live at
**https://allencrspy.github.io/ensemble/**

A public PeerJS broker handles the initial handshake only — the offer/answer
exchange. Audio, control messages and clock traffic go device to device and
never touch it.

**Local (no internet at all).** A tiny Node server holds the room instead:

```bash
node server.js
```

It prints a LAN address; every device on the same Wi-Fi opens it. Useful on a
network with no internet, and the track transfers over HTTP instead of WebRTC.

Both modes speak the same protocol — `public/room-core.js` is the single room
state machine, loaded by the Node server and by the host's browser tab alike.
The app picks its mode automatically; `?mode=p2p` or `?mode=ws` forces one.

> The microphone features (speaker-delay measurement and the room map) need a
> secure context. That means the hosted build, or `localhost` — a plain-http LAN
> address cannot use `getUserMedia`, and the app will tell you so.

## Live streaming

The host can stream whatever it is playing instead of sharing a file. **Stream
what I'm playing** opens the browser's share picker; pick a tab (or a screen)
and tick the audio box.

It is not a voice call under the hood. The host captures the audio, cuts it into
23 ms chunks, and stamps each one with the instant it should be *heard* —
capture time plus a fixed buffer. Every device, the host included, schedules
that chunk for exactly that instant. Nobody plays a chunk when it arrives; they
play it when the clock says to, which is what keeps the room together. Measured
between two machines: playback cursors 0.1 ms apart, no late chunks.

- The buffer is the **sync buffer** in the Sync tab. 700 ms is a good default;
  shorter feels more immediate and risks gaps on weak Wi-Fi.
- Audio goes out as Opus at about 130 kbps per listener (raw PCM if the browser
  has no WebCodecs), and it is distributed through a tree rather than a star —
  see below.
- Channel modes still apply, so a streamed source can still be split into a
  stereo pair or a 5.1 layout.
- **Mute the host's own speakers.** The source keeps playing out of the host
  directly, with no delay, so if you do not mute it you will hear the room twice.
- What can be captured depends on the browser: Chrome on **macOS** can take the
  audio of a *Chrome tab* (so use Spotify/YouTube's web player), not the whole
  system — full system audio there needs a virtual device such as BlackHole.
  Chrome on **Windows** can share entire-screen audio.

## Scaling to a roomful of devices

A star cannot carry 50 devices, and the reason is not bandwidth. Wi-Fi hands out
airtime **per station**: with 50 stations contending, the host is entitled to
about 1/50 of the medium, while a star requires it to transmit 49 copies of
every chunk — 49/50 of the airtime. No access point fixes that.

| | per stream | host must send | verdict |
|---|---|---|---|
| PCM s16 | 1.41 Mbps | 69 Mbps | impossible |
| Opus 128k, star | ~184 kbps on the wire | 8.8 Mbps | one station, 49 flows — fails under contention |
| Opus 128k, fanout 4 | ~184 kbps | **736 kbps** | fits inside a 1/50 share |

So two changes. **Opus** cuts each stream about elevenfold. **A distribution
tree** spreads the transmitting across the stations that are already in the
room: the host feeds four devices, each of those feeds four more. Fifty devices
fit in three hops, and no device ever uploads more than ~736 kbps.

Total airtime is the same either way — a star and a tree both have N−1 edges,
about 9 Mbps aggregate, 5–10% of a 5 GHz channel. The tree changes *who*
transmits, which is the thing that actually breaks.

Relaying is free in sync terms, and that is the whole trick: every chunk already
carries the instant it must be heard, so another hop changes when it *arrives*,
never when it *plays*. Three hops spend about 24 ms of a 700 ms buffer.

Each node looks after its own hop rather than trusting a global view: it probes
its parent every few seconds, reports that round trip to the host, and asks to
be re-parented when the link dies. The host re-plans the tree whenever anyone
joins or leaves, and tells only the devices that actually moved.

The clock deliberately does *not* go hop by hop. On one Wi-Fi network every
device is a single radio hop from the host, so measuring against the host
directly is more accurate than composing a chain of estimates — each hop would
add its own error. Timing is star-shaped and cheap (about 1 kbps per device);
only audio and failure handling are per-hop. On a multi-AP or mesh network that
trade would flip, and boundary-clock style sync would win.

Measured with four devices, one of them running a 48 kHz audio context against a
44.1 kHz capture: **playback cursors within 0.22 ms**, zero re-anchors, zero
gaps, Opus at 132 kbps.

## Latency

Delay and scale are the same dial, because Wi-Fi airtime is dominated by
per-frame overhead rather than payload. Halving the Opus frame halves the
latency floor and doubles the packet rate, and packets are what saturate the
medium — so the room's size picks the frame size automatically (5–10 ms for a
handful of devices, 40–60 ms for a crowd). Frames must also be a whole number
of samples at the capture rate: 5 ms at 44.1 kHz is 220.5 samples, and rounding
that slips the stream 2.6 ms every second.

The buffer is measured, not guessed. Every listener reports the slack its worst
chunk had — how long before its deadline it actually arrived — and **Calibrate
latency** walks the buffer down 20 ms at a time until the first device runs out
of margin or drops a sample, then settles at that floor plus a margin. In normal
running the buffer only ever goes *up*, and quickly: a continuously descending
buffer has every device chasing a moving target, which turned 0.2 ms of spread
into 9 ms. Find the floor deliberately, then hold it.

A device that struggles alone asks the host for a **second parent** rather than
making everyone else wait: two disjoint paths, and whichever copy of a chunk
lands first wins. That halves nothing on average and everything in the tail,
which is where dropouts live.

Measured on a three-device room: 700 ms → **173 ms** buffer, cursors within
**0.35 ms**, zero gaps.

## How the sync works

Streaming audio to N devices and hoping they keep up does not work: every device
has its own clock and its own output latency. Ensemble does what Snapcast and
AirPlay do — distribute the file first, agree on a clock, then schedule the same
sample for the same instant.

1. **Distribute, don't stream.** The host shares the file once; every device
   decodes it into an `AudioBuffer` before anything plays. Over HTTP in LAN mode,
   over a data channel in P2P mode (64 KB chunks, paced against the send buffer).

2. **Agree on a clock.** Each device runs a continuous NTP-style exchange with
   the room's timekeeper. Only the fastest quarter of samples are kept — a slow
   round trip means an asymmetric path, and an asymmetric path is exactly what
   biases an NTP offset. A least-squares fit over those samples also estimates
   *skew*: the parts-per-million difference between two quartz crystals, which is
   what makes naive sync drift apart over a long track.

3. **Schedule, don't start.** Every command carries an absolute timestamp plus a
   sync buffer (300 ms – 2.5 s, the host's choice). Each device converts that
   instant through `getOutputTimestamp()` — which reports the sample *currently
   audible*, so output latency is measured rather than guessed — and calls
   `source.start(when, offset)` with sample accuracy.

4. **Correct continuously.** Every 700 ms a device compares where the room says
   the playhead should be against where its own audible playhead is, and bends
   `playbackRate` by up to ±2% to close the gap. Under 3 ms it does nothing; over
   250 ms it re-schedules from scratch. (Snapcast does the same by inserting and
   dropping samples.) That loop runs on a timer, never on `requestAnimationFrame`,
   so a phone with a dark screen stays in step.

5. **Compensate per device.** Bluetooth speakers add 100–300 ms that no protocol
   can discover. **Measure speaker delay** emits a chirp, hears it back through
   the mic, and times the loop; **Auto-align** then delays every device to match
   the slowest.

Measured between two machines on a LAN: sub-millisecond agreement, settling
inside the 3 ms deadband. Peer-to-peer, where the reference is a browser tab
rather than a server, it holds within about 10 ms.

## Channel modes

**Stereo & roles** — shares of a stereo mix: Stereo, Mono, Wide (mid/side with a
Haas delay), Left, Right, Vocals (band-limited centre), Ambience (the stereo
difference), Bass (under 150 Hz), Highs (over 2.2 kHz).

**Surround 5.1 / 7.1** — one device *is* one speaker: Front L, Center, Front R,
Surround L, Surround R, LFE, Rear L, Rear R.

- With a **discrete multichannel file**, each device decodes the whole file and
  plays only its own channel, in standard order (FL FR FC LFE SL SR RL RR).
- With ordinary **stereo**, the missing channels are matrix-upmixed in the spirit
  of Pro Logic II: centre from the mid signal, fronts with the centre partly
  subtracted so it is not doubled, LFE from a low-passed mono sum, surrounds from
  the side signal delayed 18–38 ms and band-limited.
- **Auto-assign layout** hands out positions in one tap, scaled to the number of
  devices: two become L/R, three add a centre, six make a 5.1, eight a 7.1.

## The room map

Phones know where they are relative to each other, if you let them listen.

Each device emits a 24 ms chirp (2→6 kHz) at an agreed instant while the others
record; a matched filter finds the arrival to sub-sample precision. For a pair
*i, j*:

```
dt_ij + dt_ji = L_i + L_j + 2·distance/343
```

where `L` is each device's own speaker→mic loop time. Every unknown per-device
constant cancels, and the distance falls out. Classical multidimensional scaling
turns the distance matrix into 2D coordinates; the host defines "front", the
listener sits at the centroid, and roles are assigned by angle. Distances cannot
tell left from right — a mirrored room fits the data equally well — so the map
has a **Mirror** button rather than pretending to know.

**Apply to devices** then sets each role *and* its delay: near speakers are held
back so every wavefront reaches the middle together, the way an AV receiver uses
speaker distances.

Against synthetic geometry with ±0.5 ms of jitter, pairwise distances came back
within 13 cm and every surround role landed on the right device. In a real room,
expect reverb and noise to matter more than the maths.

## Device sensors

- **Wake Lock** — the screen sleeping is the most common way a device drops out.
- **Battery** — level and charging state reach the host, so a speaker about to
  die is visible before it dies.
- **Motion** — shake to resync; put the phone face-down to mute it.
- **Haptics** — a muted phone still pulses on the beat.
- **Connection** — link quality, which informs the sync buffer.

Each one degrades quietly where the browser does not expose it (iOS has no
Battery API, desktops have no motion sensors).

## Why there is no Bluetooth mesh

A web page cannot send audio over Bluetooth. Web Bluetooth is GATT only — there
is no API for A2DP, LE Audio or Auracast — and iOS Safari does not implement Web
Bluetooth at all. It would also be the wrong direction for quality: Bluetooth
re-encodes with a lossy codec and adds 100–300 ms of its own latency. Each phone
decoding the full-quality file locally and playing it against a shared clock
beats it on both counts. If a phone is itself feeding a Bluetooth speaker, the
delay measurement above is what compensates for it.

## Refreshing

A reload does not cost you the room. The session is kept per tab, and on load
the app walks straight back in — a listener rejoins by code, and a **host
re-hosts under the same code**, so devices that were knocking on that name
simply reconnect. Because each browser carries a stable key, the room
recognises the returning device and hands back its role, trim and volume
instead of adding a second speaker. Listeners keep retrying for about two
minutes, which comfortably covers a host refresh.

What does not survive a host refresh: the shared file and any live capture,
since both live in that tab's memory and screen capture needs a fresh gesture.
The room, the devices and their settings all do.

## Limits

- The host shares a *file*, not its live system audio. Mirroring whatever the
  host happens to be playing needs capture and streaming, and a live stream
  cannot be scheduled ahead — which is exactly what buys the tight sync.
- Peer-to-peer mode assumes devices can reach each other directly, which is the
  normal case on one Wi-Fi network. Across separate networks WebRTC would need a
  TURN relay, which is not included.
- Tracks live in memory (200 MB cap in LAN mode) and disappear with the room.
- The public PeerJS broker is a free shared service. For anything serious, run
  your own — it is one npm package — and point `PEER_PREFIX`/`Peer()` at it in
  `public/net.js`.

## Licence

MIT. See [LICENSE](LICENSE).
