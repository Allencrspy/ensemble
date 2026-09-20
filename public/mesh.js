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

  return { FANOUT, plan, cost };
}));
