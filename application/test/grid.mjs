// Checks src/web/grid.js against exact BigInt arithmetic: node test/grid.mjs
// For every BPM (30–240) and horizons from 1 min to 10 years, with t random and right next to a beat (±3 ulp):
//   - beatAfter returns exactly the index of the first beat strictly after t;
//   - beatTime(n) lands within half an ulp (122.07 ns) of the exact instant;
//   - the result is never before t, and only equals t when the exact beat is ≤ 122.07 ns away.
import assert from "node:assert/strict";
import { beatAfter, beatTime } from "../src/web/grid.js";

const T0 = 1_794_588_000_000, ULP = 1 / 4096; // t ≈ 1.8e12 ms: a double steps by 2^-12 ms
const HORIZONS = [6e4, 3.6e6, 8.64e7, 3.15e10, 3.15e11];
const HALF_ULP_NS = (ULP / 2) * 1e6;
let seed = 7;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

let cases = 0, equalToT = 0, worstNs = 0;
const check = (bpm, t) => {
  if (t < T0) return; // before the start: outside the domain
  const F = BigInt(bpm), tu = BigInt(t / ULP), t0u = BigInt(T0 / ULP);
  const step = 60000n * 4096n; // one beat = 60000·4096 / bpm (in ULP units)
  const exactN = ((tu - t0u) * F) / step + 1n;
  const n = beatAfter(T0, bpm, t);
  assert.equal(BigInt(n), exactN, `wrong index: bpm ${bpm}, t ${t}`);

  const b = beatTime(T0, bpm, n);
  const errNs = Number((BigInt(b / ULP) * F - (t0u * F + exactN * step)) * 1_000_000n / F) / 4096; // ns
  const distNs = Number(((t0u * F + exactN * step) - tu * F) * 1_000_000n / F) / 4096; // exact beat − t, in ns
  assert.ok(Math.abs(errNs) <= HALF_ULP_NS + 1e-6, `error ${errNs} ns: bpm ${bpm}, t ${t}`);
  assert.ok(b >= t, `beat before t: bpm ${bpm}, t ${t}`);
  if (b === t) { assert.ok(distNs <= HALF_ULP_NS + 1e-6, `equal to t with the beat ${distNs} ns away`); equalToT++; }
  worstNs = Math.max(worstNs, Math.abs(errNs));
  cases++;
};

for (let bpm = 30; bpm <= 240; bpm++)
  for (const h of HORIZONS)
    for (let i = 0; i < 100; i++) {
      check(bpm, T0 + Math.floor(rnd() * h / ULP) * ULP);
      const k = Math.floor(rnd() * h * bpm / 60000), b = T0 + (k * 60000) / bpm;
      for (let d = -3; d <= 3; d++) check(bpm, b + d * ULP);
    }

// before t0 the first beat is beat 0, at t0
assert.equal(beatAfter(T0, 120, T0 - 1000), 0);
assert.equal(beatTime(T0, 120, 0), T0);
// 120 BPM: T = 500 ms; started 10 300 ms ago → the next one is the 21st, 200 ms from now
assert.equal(beatAfter(T0, 120, T0 + 10_300), 21);
assert.equal(beatTime(T0, 120, 21) - (T0 + 10_300), 200);

console.log(`grid.js ok: ${cases} cases, worst error ${worstNs.toFixed(2)} ns, ${equalToT} results equal to t (beat ≤ 122 ns away)`);
