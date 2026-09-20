/* Ensemble — distribution tree.
 *
 * A star cannot carry 50 devices: Wi-Fi hands out airtime per station, so the
 * host would need 49/50 of the medium while contention entitles it to 1/50.
 * The fix is not less traffic — a star and a tree both have N-1 edges and cost
 * the same airtime in total — it is spreading the *transmitting* across the
 * stations that are already there.
 *
 * Relaying is free in sync terms. Every chunk carries the instant it must be
 * heard, so another hop changes when it arrives, never when it plays. The
 * buffer absorbs the difference.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Mesh = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FANOUT = 4;

  /**
   * Breadth-first tree over the devices, host at the root, oldest first so the
   * shape is stable as people come and go. Returns id -> {parent, depth}.
   *
   * Depth matters twice: it is added latency (~8 ms a hop on Wi-Fi) and it is
   * fragility (an orphaned node takes its subtree with it until it re-parents),
   * so we keep the fanout wide enough that 50 devices fit in three hops.
   */
  function plan(devices, hostId, fanout = FANOUT) {
    const order = [...devices].sort((a, b) => {
      if (a.id === hostId) return -1;
      if (b.id === hostId) return 1;
      return a.joinedAt - b.joinedAt;
    });
    const out = new Map();
    if (!order.length) return out;

    const root = order[0];
    out.set(root.id, { parent: null, depth: 0, children: [] });

    // Prefer parents that are shallow, then those that have been around longest.
    const slots = [{ id: root.id, depth: 0, used: 0 }];
    let cursor = 0;
    for (let i = 1; i < order.length; i++) {
      while (cursor < slots.length && slots[cursor].used >= fanout) cursor++;
      const p = slots[cursor] || slots[slots.length - 1];
      p.used++;
      out.set(order[i].id, { parent: p.id, depth: p.depth + 1, children: [] });
      out.get(p.id).children.push(order[i].id);
      slots.push({ id: order[i].id, depth: p.depth + 1, used: 0 });
    }
    return out;
  }

  /** What the shape costs: depth, worst-case hops, and per-station upload. */
  function cost(treeMap, perStreamKbps = 184) {
    let maxDepth = 0, maxFan = 0;
    const fanOf = new Map();
    for (const [id, node] of treeMap) {
      maxDepth = Math.max(maxDepth, node.depth);
      const f = node.children.length;
      fanOf.set(id, f);
      maxFan = Math.max(maxFan, f);
    }
    return {
      devices: treeMap.size,
      maxDepth,
      maxFanout: maxFan,
      worstUplinkKbps: maxFan * perStreamKbps,
      aggregateKbps: Math.max(0, treeMap.size - 1) * perStreamKbps,
      addedLatencyMs: maxDepth * 8,        // ~8 ms a hop, measured on Wi-Fi
    };
  }

  /**
   * Frame size is the latency dial and the scale dial at once, because Wi-Fi
   * airtime is dominated by per-frame overhead (~167 us) rather than payload.
   * Halving the frame halves the latency floor and doubles the packets, and
   * packets are what saturate the medium:
   *
   *    frame   4 devices   12 devices   50 devices
   *     5 ms      11%          42%         185%   <- impossible
   *    10 ms       6%          22%          98%
   *    20 ms       3%          12%          54%
   *    40 ms       2%           7%          32%
   *
   * So a small room gets short frames and low latency; a big one gets long
   * frames and stays on the air. Aim to keep the stream under ~15% occupancy.
   */
  function frameMsFor(devices, budget = 0.15, rate = 48000) {
    const edges = Math.max(1, devices - 1);
    for (const ms of [5, 10, 20, 40, 60]) {
      // A frame has to be a whole number of samples at the capture rate, or the
      // encoder's timeline slips against real time: 5 ms at 44.1 kHz is 220.5
      // samples, and rounding to 221 drifts 0.23% — about 2.6 ms every second.
      if (Math.abs((rate * ms) / 1000 - Math.round((rate * ms) / 1000)) > 1e-9) continue;
      const bytes = Math.round(128000 * (ms / 1000) / 8) + 100;
      const perPkt = 167 + (bytes * 8) / 65;         // us of airtime
      if (((1000 / ms) * edges * perPkt) / 1e6 <= budget) return ms;
    }
    return 60;
  }

  /**
   * A second, disjoint parent for the nodes that need one. Redundancy is what
   * shortens the *tail*: with two paths the listener takes whichever copy lands
   * first, so a retry or a scan on one link stops mattering. It doubles that
   * node's share of the air, so it is handed out on request, not by default.
   */
  function backupFor(treeMap, id, fanout = FANOUT) {
    const me = treeMap.get(id);
    if (!me || !me.parent) return null;

    const ancestors = new Set();
    for (let cur = me; cur && cur.parent; cur = treeMap.get(cur.parent)) ancestors.add(cur.parent);
    const descendants = new Set();
    const walk = (n) => (treeMap.get(n) || { children: [] }).children.forEach((c) => { descendants.add(c); walk(c); });
    walk(id);

    let best = null;
    for (const [other, node] of treeMap) {
      if (other === id || other === me.parent) continue;
      if (descendants.has(other) || ancestors.has(other)) continue;   // must not create a cycle
      if (node.depth > me.depth) continue;                            // never take audio from below
      const load = node.children.length + (node.backups || 0);
      if (load >= fanout + 2) continue;
      if (!best || node.depth < best.depth || (node.depth === best.depth && load < best.load)) {
        best = { id: other, depth: node.depth, load };
      }
    }
    if (best) {
      const n = treeMap.get(best.id);
      n.backups = (n.backups || 0) + 1;
    }
    return best ? best.id : null;
  }

  return { FANOUT, plan, cost, frameMsFor, backupFor };
}));
