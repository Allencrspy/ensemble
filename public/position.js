/* Ensemble — where the phones are.
 *
 * Round-robin chirps give a matrix of device-to-device distances (see
 * acoustic.js). Classical multidimensional scaling turns that matrix into 2D
 * coordinates, which is enough to hand out surround roles by angle and to set
 * each speaker's delay from its distance — what an AV receiver asks you to
 * measure with a tape.
 *
 * Distances cannot tell left from right (a mirrored room fits equally well),
 * so the map has a Mirror control rather than pretending to know.
 */
'use strict';

/* ───────────────────────────── linear algebra ──────────────────────────── */

/** Jacobi eigenvalue iteration for a small symmetric matrix. */
function jacobiEigen(Ain, sweeps = 60) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-14) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - sn * akq;
          A[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - sn * aqk;
          A[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - sn * vkq;
          V[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}

/** Classical MDS: an n×n distance matrix in, 2D points out. */
function mds2(D) {
  const n = D.length;
  if (n < 2) return [{ x: 0, y: 0 }];
  const D2 = D.map((row) => row.map((v) => v * v));
  const rowMean = D2.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const grand = rowMean.reduce((a, b) => a + b, 0) / n;
  const B = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => -0.5 * (D2[i][j] - rowMean[i] - rowMean[j] + grand)));

  const { values, vectors } = jacobiEigen(B);
  const order = values.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const [e1, e2] = [order[0], order[1] || [0, 0]];
  const s1 = Math.sqrt(Math.max(0, e1[0])), s2 = Math.sqrt(Math.max(0, e2[0]));
  return Array.from({ length: n }, (_, i) => ({
    x: (vectors[i][e1[1]] || 0) * s1,
    y: (vectors[i][e2[1]] || 0) * s2,
  }));
}

/* ───────────────────────────── geometry → roles ────────────────────────── */

/** Where each surround role wants to sit, in degrees clockwise from front. */
const ROLE_ANGLES = { fc: 0, fl: -30, fr: 30, sl: -100, sr: 100, rl: -145, rr: 145 };

/**
 * Turn raw MDS coordinates into a usable map: listener at the centroid, the
 * host device defining "front", and a metre scale.
 */
function orientMap(points, ids, hostId, mirror) {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  let pts = points.map((p) => ({ x: p.x - cx, y: p.y - cy }));
  if (mirror) pts = pts.map((p) => ({ x: -p.x, y: p.y }));

  // Rotate so the host sits straight ahead (at the top of the map).
  const hi = ids.indexOf(hostId);
  const ref = hi >= 0 ? pts[hi] : pts[0];
  const a = Math.atan2(ref.x, -ref.y);             // angle of the reference from "front"
  const cos = Math.cos(-a), sin = Math.sin(-a);
  return pts.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

const angleOf = (p) => (Math.atan2(p.x, -p.y) * 180) / Math.PI;   // 0 = front, + = right

/** Greedy best-fit of devices to speaker positions by angle. */
function assignRoles(points, ids) {
  const n = ids.length;
  if (n === 1) return { [ids[0]]: 'stereo' };
  if (n === 2) {
    const [a, b] = ids.map((id, i) => ({ id, ang: angleOf(points[i]) })).sort((x, y) => x.ang - y.ang);
    return { [a.id]: 'fl', [b.id]: 'fr' };
  }
  const roles = Object.keys(ROLE_ANGLES).slice(0, Math.min(n, 7));
  const pairs = [];
  ids.forEach((id, i) => {
    const ang = angleOf(points[i]);
    roles.forEach((r) => {
      let d = Math.abs(ang - ROLE_ANGLES[r]);
      if (d > 180) d = 360 - d;
      pairs.push({ id, role: r, cost: d });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const out = {}, usedRole = new Set();
  for (const p of pairs) {
    if (out[p.id] || usedRole.has(p.role)) continue;
    out[p.id] = p.role;
    usedRole.add(p.role);
  }
  for (const id of ids) if (!out[id]) out[id] = 'mono';
  return out;
}

/** Delay the near speakers so every wavefront reaches the middle together. */
function delaysFromMap(points, ids, calib) {
  const dist = points.map((p) => Math.hypot(p.x, p.y));
  const dMax = Math.max(...dist);
  const cals = ids.map((id) => (typeof calib[id] === 'number' ? calib[id] : 0));
  const cMax = Math.max(...cals);
  const out = {};
  ids.forEach((id, i) => {
    const flight = ((dMax - dist[i]) / SPEED_OF_SOUND) * 1000;
    out[id] = Math.round(clamp((cMax - cals[i]) + flight, -500, 500));
  });
  return out;
}

/* ─────────────────────────── the ranging session ───────────────────────── */

const Ranger = {
  running: false,
  reports: new Map(),          // "from>to" -> dt in ms
  map: null,                   // { ids, points, roles, delays, quality, mirror }
  mirror: false,

  key: (from, to) => `${from}>${to}`,

  /** Called on every device when the host announces a chirp. */
  async participate(by, at) {
    if (!Acoustic.supported() || !Engine.unlocked()) return;
    const mine = by === App.id;
    try {
      if (mine) {
        const listening = Acoustic.listenFor(at, 800);
        await sleep(30);
        Acoustic.emitAt(at);
        const r = await listening;
        if (r) Net.send({ t: 'relay', to: 'host', payload: { k: 'heard', by, dt: r.dt, conf: r.conf } });
      } else {
        const r = await Acoustic.listenFor(at, 800);
        if (r) Net.send({ t: 'relay', to: 'host', payload: { k: 'heard', by, dt: r.dt, conf: r.conf } });
      }
    } catch (e) { /* a device that cannot hear simply contributes nothing */ }
  },

  note(from, to, dt) { this.reports.set(this.key(from, to), dt); },

  /** Host side: run the whole round-robin, then solve. */
  async run(onStep) {
    if (this.running) return null;
    this.running = true;
    this.reports.clear();
    try {
      const devices = [...App.room.devices];
      const ids = devices.map((d) => d.id);
      if (ids.length < 2) throw new Error('Need at least two devices');

      // 1. Everyone measures their own speaker→mic loop.
      onStep('measuring each speaker…');
      Net.send({ t: 'relay', to: '*', payload: { k: 'selfcal' } });
      await Ranger.selfCalibrateLocal();
      await this.waitFor(() => App.room.devices.every((d) => typeof d.calib === 'number'), 25000);

      // 2. Each device chirps in turn while the others listen.
      for (let i = 0; i < ids.length; i++) {
        const by = ids[i];
        const name = devices[i].name;
        onStep(`listening to ${name} (${i + 1}/${ids.length})…`);
        const at = Clock.now() + 1400;
        Net.send({ t: 'relay', to: '*', payload: { k: 'chirp', by, at } });
        await this.participate(by, at);
        await sleep(900);
      }

      onStep('solving the room…');
      await sleep(400);
      const solved = this.solve(App.room.devices);
      if (!solved) throw new Error('Not enough clear chirps — try again somewhere quieter');
      this.map = solved;
      return solved;
    } finally { this.running = false; }
  },

  async selfCalibrateLocal() {
    try {
      const ms = await Acoustic.selfLoop(3);
      Engine.calib = ms;
      Net.send({ t: 'state', patch: { calib: ms } });
    } catch { /* reported by the UI elsewhere */ }
  },

  waitFor(cond, ms) {
    const t0 = performance.now();
    return new Promise((res) => {
      const tick = () => {
        if (cond() || performance.now() - t0 > ms) return res(cond());
        setTimeout(tick, 250);
      };
      tick();
    });
  },

  /** Distances from the symmetric round trip, then MDS, roles and delays. */
  solve(devices) {
    const usable = devices.filter((d) => typeof d.calib === 'number');
    const ids = usable.map((d) => d.id);
    const n = ids.length;
    if (n < 2) return null;

    const calib = {};
    usable.forEach((d) => { calib[d.id] = d.calib; });

    const D = Array.from({ length: n }, () => new Array(n).fill(0));
    let measured = 0, total = 0;
    const fallback = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        total++;
        const ab = this.reports.get(this.key(ids[i], ids[j]));
        const ba = this.reports.get(this.key(ids[j], ids[i]));
        if (ab == null || ba == null) { fallback.push([i, j]); continue; }
        // dt_ij + dt_ji = L_i + L_j + 2·d/c  →  d = c·(sum − L_i − L_j)/2
        const metres = (SPEED_OF_SOUND * ((ab + ba - calib[ids[i]] - calib[ids[j]]) / 1000)) / 2;
        D[i][j] = D[j][i] = clamp(metres, 0.05, 30);
        measured++;
      }
    }
    if (measured < Math.max(1, total * 0.6)) return null;

    // Fill any gap with the average measured distance; MDS tolerates a little slack.
    const avg = D.flat().filter((v) => v > 0).reduce((a, b, _, arr) => a + b / arr.length, 0) || 2;
    fallback.forEach(([i, j]) => { D[i][j] = D[j][i] = avg; });

    const raw = mds2(D);
    const points = orientMap(raw, ids, App.room.hostId, this.mirror);

    // Residual stress tells us how much to trust the picture.
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const fit = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      num += (fit - D[i][j]) ** 2; den += D[i][j] ** 2;
    }
    const stress = den ? Math.sqrt(num / den) : 1;

    return {
      ids, points, distances: D,
      roles: assignRoles(points, ids),
      delays: delaysFromMap(points, ids, calib),
      coverage: total ? measured / total : 0,
      stress,
      mirror: this.mirror,
    };
  },

  /** Re-solve from the reports already collected (used by the Mirror control). */
  resolveMap() {
    if (!this.reports.size) return null;
    this.map = this.solve(App.room.devices);
    return this.map;
  },
};

/* ────────────────────────────── the drawing ────────────────────────────── */

function renderRoomMap(el, map) {
  if (!map) { el.innerHTML = '<p class="hint">No map yet.</p>'; return; }
  const W = 320, H = 260, pad = 34;
  const span = Math.max(1.2, ...map.points.map((p) => Math.hypot(p.x, p.y))) * 1.15;
  const sx = (v) => W / 2 + (v / span) * (W / 2 - pad);
  const sy = (v) => H / 2 + (v / span) * (H / 2 - pad);

  const rings = [0.33, 0.66, 1].map((r) =>
    `<circle cx="${W / 2}" cy="${H / 2}" r="${r * (Math.min(W, H) / 2 - pad)}" class="ring"/>`).join('');

  const dots = map.points.map((p, i) => {
    const id = map.ids[i];
    const dev = App.room.devices.find((d) => d.id === id);
    const role = map.roles[id];
    const short = (MODE_BY_ID[role] || {}).short || (MODE_BY_ID[role] || {}).label || '';
    const dist = Math.hypot(p.x, p.y).toFixed(1);
    return `
      <g class="node${id === App.id ? ' me' : ''}${id === App.room.hostId ? ' host' : ''}">
        <circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="13"/>
        <text x="${sx(p.x)}" y="${sy(p.y) + 3.5}" class="tag">${short}</text>
        <text x="${sx(p.x)}" y="${sy(p.y) - 19}" class="nm">${escapeHtml((dev && dev.name) || '?')}</text>
        <text x="${sx(p.x)}" y="${sy(p.y) + 27}" class="m">${dist} m</text>
      </g>`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="roommap" role="img" aria-label="Room map">
      ${rings}
      <path d="M${W / 2} ${pad - 16} l6 10 h-12 z" class="front"/>
      <text x="${W / 2}" y="${pad - 20}" class="front-label">front</text>
      <circle cx="${W / 2}" cy="${H / 2}" r="6" class="listener"/>
      <text x="${W / 2}" y="${H / 2 + 20}" class="listener-label">you</text>
      ${dots}
    </svg>
    <div class="map-stats">
      <span>${map.ids.length} placed</span>
      <span>${Math.round(map.coverage * 100)}% of pairs heard</span>
      <span class="${map.stress < 0.12 ? 'ok' : 'warn'}">fit ${(map.stress * 100).toFixed(0)}%</span>
    </div>`;
}
