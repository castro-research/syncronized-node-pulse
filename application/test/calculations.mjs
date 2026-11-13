// Ways to compute the next beat from (start, BPM) alone, beyond the formula in the paper.
// Each calculation runs in its own process, all in parallel:
//   node calculations.mjs            runs everything
//   node calculations.mjs sum        runs just one
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const T0 = 1_794_588_000_000; // start: Unix time in ms (integer)
const DAY = 86_400_000; // horizon of the arithmetic tests: 24 h
const SR = 48_000; // audio samples per second
const BPMS = Array.from({ length: 211 }, (_, i) => 30 + i); // 30…240
const PS = 1_000_000_000n; // picoseconds per ms
const T0_PS = BigInt(T0) * PS;

// ── helpers ──────────────────────────────────────────────────────────────────

function rng(seed) { // mulberry32: reproducible random, 53 bits, always < 1
  const r = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return () => r() + Math.floor(r() * 2 ** 21) / 2 ** 53;
}

const num = (x, places) => (Math.round(x * 10 ** places) / 10 ** places + 0).toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
const fmt = ns => (ns < 1e3 ? `${num(ns, 1)} ns` : ns < 1e6 ? `${num(ns / 1e3, 1)} µs` : `${num(ns / 1e6, 1)} ms`);
const ms = x => num(x, 3);

// ── arithmetic: does the computed instant land on the exact grid? ────────────
// Exact grid: beat k at start + k·60000/f ms. It is a rational; here it is rounded to 1 ps.

const toPs = x => { const i = Math.floor(x); return BigInt(i) * PS + BigInt(Math.round((x - i) * 1e9)); }; // double (ms) → ps
const beatPs = (f, k) => T0_PS + (2n * k * 60_000n * PS + f) / (2n * f); // f and k as BigInt

function meter() {
  let h1 = 0, h24 = 0, worst = 0, bpm = 0, cases = 0;
  return {
    add(f, hours, ns) {
      const a = Math.abs(ns);
      cases++;
      if (hours < 1) h1 = Math.max(h1, a);
      if (hours >= 23) h24 = Math.max(h24, a);
      if (a > worst) { worst = a; bpm = f; }
    },
    row: () => ({ "max error in hour 1": fmt(h1), "max error in hour 24": fmt(h24), "worst BPM": bpm || "—", cases }),
  };
}

// For calculations of the kind "which beat comes after t?".
function testNext(next) {
  const u = rng(1), m = meter();
  let wrong = 0;
  for (const f of BPMS) {
    const F = BigInt(f), T = 60000 / f;
    for (let i = 0; i < 3000; i++) {
      let t = T0 + u() * DAY;
      // 1 in 3: t right next to a beat (±1 ulp), where a floor can slip
      if (i % 3 === 0) t = T0 + Math.round((t - T0) / T) * T + (Math.floor(u() * 3) - 1) * 2 ** -12;
      const r = next(f, t), ps = typeof r === "bigint" ? r : toPs(r);
      const k = (2n * (ps - T0_PS) * F + 60_000n * PS) / (120_000n * PS); // exact beat closest to the result
      m.add(f, (t - T0) / 3.6e6, Number(ps - beatPs(F, k)) / 1000);
      const wait = Number(ps - toPs(t)) / 1e9; // ms between t and the returned beat
      if (wait < -1e-3 || wait > T + 1e-3) wrong++; // it has to be the next one (tolerance: 1 µs)
    }
  }
  return { ...m.row(), "wrong next": wrong };
}

// For calculations that advance beat by beat: make(f) returns k => instant of beat k (k always growing).
function testSequence(make) {
  const m = meter();
  for (const f of BPMS) {
    const F = BigInt(f), at = make(f);
    for (let k = 257; (k * 60000) / f <= DAY; k += 257) {
      const r = at(k), ps = typeof r === "bigint" ? r : toPs(r);
      m.add(f, k / f / 60, Number(ps - beatPs(F, BigInt(k))) / 1000);
    }
  }
  return m.row();
}

// Per-audio-sample counter: adds `inc` on every sample and fires a beat each time it passes `wrap`.
// Beat k lands on sample ⌈k·wrap/inc⌉ (closed form of the loop).
const samplePs = s => T0_PS + (s * 1000n * PS) / BigInt(SR);
const perSample = (inc, wrap) => k => samplePs((BigInt(k) * BigInt(wrap) + BigInt(inc) - 1n) / BigInt(inc));
function verify(inc, wrap) { // the closed form has to match the literal loop, sample by sample (60 s)
  const at = perSample(inc, wrap);
  for (let s = 1, acc = 0, k = 0; s <= 60 * SR; s++)
    if ((acc += inc) >= wrap) {
      acc -= wrap;
      if (at(++k) !== samplePs(BigInt(s))) throw new Error("closed form ≠ loop");
    }
}
const inc32 = f => Math.round((2 ** 32 * f) / (60 * SR));
const frac = x => x - Math.floor(x);

// ── clock: how wrong "what time is it" can be (= error in the instant of the beat) ──
// Each request yields { l0, S, l1 }: local time on send, server time, local time on arrival (ms).

const DRIFT = 101e-6; // upper bound on the drift between clocks (100 ppm + margin)
const ESTIMATORS = ["1 request", "mean", "median", "shortest round trip", "intersection"];

function estimate(s) {
  const e = s.map(x => x.S - (x.l0 + x.l1) / 2), o = [...e].sort((a, b) => a - b), end = s.at(-1).l1;
  const best = s.reduce((a, b) => (b.l1 - b.l0 < a.l1 - a.l0 ? b : a));
  // The server stamped between l0 and l1, so the offset is guaranteed to be in [S − l1, S − l0]
  // (widened by the drift possible since then). The intersection of all requests contains it too.
  const lo = Math.max(...s.map(x => x.S - x.l1 - DRIFT * (end - x.l0)));
  const hi = Math.min(...s.map(x => x.S - x.l0 + DRIFT * (end - x.l0)));
  return {
    "1 request": e[0],
    "mean": e.reduce((a, b) => a + b) / e.length,
    "median": (o[(o.length - 1) >> 1] + o[o.length >> 1]) / 2,
    "shortest round trip": best.S - (best.l0 + best.l1) / 2, // what src/web/clock.js does
    "intersection": (lo + hi) / 2,
    lo, hi,
  };
}

function summary(e) { // e: errors in ms
  const mean = e.reduce((a, b) => a + b) / e.length, abs = e.map(Math.abs).sort((a, b) => a - b);
  return { mean, sigma: Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length), p95: abs[Math.floor(0.95 * e.length)] };
}

// Monte Carlo: local clock with unknown offset and drift, network with random delay.
function simulate(title, { base, asymmetry, jitter }) {
  const u = rng(7), exp = m => -m * Math.log(1 - u());
  const normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  // one-way delay: fixed minimum + exponential queue + occasional spike (5 %)
  const delay = side => base + (side * asymmetry) / 2 + exp(jitter) + (u() < 0.05 ? exp(10 * jitter) : 0);
  const H = [0, 30_000, 300_000], REG = "regression (10 rounds)", names = [...ESTIMATORS, REG], CASES = 20_000;
  const errors = Object.fromEntries(names.map(n => [n, H.map(() => [])]));
  let inside = 0, half = 0;
  for (let c = 0; c < CASES; c++) {
    const rho = Math.max(-1e-4, Math.min(1e-4, normal() * 20e-6)); // local clock drift: σ = 20 ppm
    const o = (u() - 0.5) * 1000;
    const L = tau => tau * (1 + rho) + o; // local time at the true instant tau
    const offset = tau => tau - L(tau); // what we want to estimate (server − local)
    const xs = [], ys = [];
    let est, tau;
    for (let r = 0; r < 10; r++) { // one round of 8 back-to-back requests every 30 s, as in src/web/clock.js
      tau = r * 30_000;
      const s = [];
      for (let j = 0; j < 8; j++) {
        const out = delay(1), back = delay(-1);
        s.push({ l0: L(tau), S: tau + out, l1: L(tau + out + back) });
        tau += out + back;
      }
      est = estimate(s);
      xs.push(L(tau));
      ys.push(est["intersection"]);
    }
    if (est.lo <= offset(tau) && offset(tau) <= est.hi) inside++;
    half += (est.hi - est.lo) / 2;
    // linear regression over the 10 rounds: offset(L) = a + b·L, so it estimates the drift as well
    const mx = xs.reduce((a, b) => a + b) / 10, my = ys.reduce((a, b) => a + b) / 10;
    const b = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    H.forEach((h, i) => {
      const v = offset(tau + h);
      for (const n of ESTIMATORS) errors[n][i].push(est[n] - v);
      errors[REG][i].push(my + b * (L(tau + h) - mx) - v);
    });
  }
  return {
    title: `${title}: minimum ${base} ms each way, asymmetry ${asymmetry} ms, mean queue ${jitter} ms (error in ms)`,
    rows: names.map(n => {
      const [a, b, c] = errors[n].map(summary);
      return { estimator: n, "bias": ms(a.mean), "σ": ms(a.sigma), "p95 now": ms(a.p95), "p95 after 30 s": ms(b.p95), "p95 after 5 min": ms(c.p95) };
    }),
    note: `deterministic guarantee (interval): true offset inside in ${num((100 * inside) / CASES, 2)} % of ${CASES} cases; mean half-width ±${ms(half / CASES)} ms`,
  };
}

// Real measurement: client and server on the same machine share the clock, so the true offset is 0
// and any estimated offset is pure estimator + network error.
async function measure(title, url) {
  const now = () => performance.timeOrigin + performance.now();
  const request = async () => {
    const l0 = now(), S = +(await (await fetch(url, { cache: "no-store" })).text());
    if (!Number.isFinite(S)) throw new Error("invalid response");
    return { l0, S, l1: now() };
  };
  try { await request(); } catch (e) { return { title, rows: [], note: `${url} unreachable (${e.message}): measurement skipped` }; }
  const errors = Object.fromEntries(ESTIMATORS.map(n => [n, []])), rtt = [], ROUNDS = 40;
  let inside = 0, half = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const s = [];
    for (let j = 0; j < 8; j++) s.push(await request());
    const est = estimate(s);
    for (const n of ESTIMATORS) errors[n].push(est[n]);
    rtt.push(...s.map(x => x.l1 - x.l0));
    if (est.lo <= 0 && 0 <= est.hi) inside++;
    half += (est.hi - est.lo) / 2;
  }
  rtt.sort((a, b) => a - b);
  return {
    title: `${title}: ${url}, ${ROUNDS} rounds of 8 requests (error in ms)`,
    rows: ESTIMATORS.map(n => { const a = summary(errors[n]); return { estimator: n, "bias": ms(a.mean), "σ": ms(a.sigma), "p95": ms(a.p95) }; }),
    note: `round trip: minimum ${ms(rtt[0])} ms, median ${ms(rtt[rtt.length >> 1])} ms; the guaranteed interval contains the true offset in ${inside}/${ROUNDS} rounds, mean half-width ±${ms(half / ROUNDS)} ms`,
  };
}

// ── the calculations (one process each) ──────────────────────────────────────

const calculations = {
  // Paper (eq. 4): phase since 1970 in seconds; θ lines the grid up with the start.
  phase: () => testNext((f, t) => {
    const T = 60 / f, theta = 1 - frac(T0 / 1000 / T);
    return t + (1 - frac(frac(t / 1000 / T) + theta)) * T * 1000;
  }),
  // Index relative to the start: n = ⌊(t − t0)/T⌋ + 1, next = t0 + n·T.
  relative: () => testNext((f, t) => { const T = 60000 / f; return T0 + (Math.floor((t - T0) / T) + 1) * T; }),
  // Remainder: T − ((t − t0) mod T) is left until the next one.
  remainder: () => testNext((f, t) => { const T = 60000 / f; return t + (T - ((t - T0) % T)); }),
  // Exact rational, integers only (ns): n = ⌊e·f/60e9⌋ + 1, next = t0 + n·60e9/f. Rounds a single time, at the end.
  rational: () => testNext((f, t) => {
    const F = BigInt(f), t0 = BigInt(T0) * 1_000_000n, e = toPs(t) / 1000n - t0;
    const n = (e * F) / 60_000_000_000n + 1n;
    return (t0 + (2n * n * 60_000_000_000n + F) / (2n * F)) * 1000n;
  }),
  // Sum: next = previous + T. Every addition rounds, and the rounding piles up.
  sum: () => testSequence(f => {
    const T = 60000 / f;
    let x = T0, i = 0;
    return k => { while (i < k) { x += T; i++; } return x; };
  }),
  // 32-bit phase accumulator per sample (NCO/DDS, as in synthesizers): phase += inc; a beat when it wraps.
  accumulator: () => { verify(inc32(97), 2 ** 32); return testSequence(f => perSample(inc32(f), 2 ** 32)); },
  // Bresenham: the same counter, but with the exact ratio f/(60·SR): acc += f; a beat when acc ≥ 60·SR.
  bresenham: () => { verify(97, 60 * SR); return testSequence(f => perSample(f, 60 * SR)); },

  "clock-lan": () => simulate("Simulated clock, local network", { base: 0.3, asymmetry: 0, jitter: 0.2 }),
  "clock-internet": () => simulate("Simulated clock, Internet", { base: 20, asymmetry: 4, jitter: 5 }),
  "real-local": () => measure("Measured clock, localhost", "http://127.0.0.1:3000/time"),
  "real-tunnel": () => measure("Measured clock, Cloudflare tunnel", "https://pulse.kurz.fyi/time"),
};

// ── processes ────────────────────────────────────────────────────────────────

if (process.send) { // child process: runs one calculation and hands the result back to the parent
  const name = process.argv[2], t = performance.now(), r = await calculations[name]();
  process.send({ name, pid: process.pid, s: (performance.now() - t) / 1000, r }, () => process.exit());
} else { // parent process: one process per calculation, all in parallel
  const names = process.argv[2] ? [process.argv[2]] : Object.keys(calculations);
  if (!names.every(n => calculations[n])) {
    console.error(`available calculations: ${Object.keys(calculations).join(", ")}`);
    process.exit(1);
  }
  const t = performance.now();
  const res = await Promise.all(names.map(n => new Promise((ok, fail) => {
    fork(fileURLToPath(import.meta.url), [n])
      .once("message", ok)
      .once("error", fail)
      .once("exit", c => c && fail(new Error(`${n}: exited with code ${c}`)));
  })));
  const arith = res.filter(x => !x.r.rows);
  if (arith.length) {
    console.log("\nArithmetic: computed instant vs. exact grid (BPM 30–240, 24 h from the start)");
    console.table(arith.map(x => ({ "calculation": x.name, ...x.r, pid: x.pid, s: num(x.s, 1) })));
  }
  for (const x of res.filter(x => x.r.rows)) {
    console.log(`\n${x.r.title}  [pid ${x.pid}, ${num(x.s, 1)} s]`);
    if (x.r.rows.length) console.table(x.r.rows);
    console.log(x.r.note);
  }
  console.log(`\n${res.length} processes in parallel: ${num((performance.now() - t) / 1000, 1)} s wall clock, ${num(res.reduce((a, x) => a + x.s, 0), 1)} s summed`);
}
