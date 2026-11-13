// Server time, estimated on this device over HTTP (see "How it works").
//
// Each round makes 8 requests to /time and keeps the sample with the shortest round trip, the one
// with the least error: the error is ≤ round trip / 2, and route asymmetry is never visible. The
// last 10 rounds feed a linear regression that also estimates the drift of the local clock:
//   offset(x) = server − local ≈ a + b · (x − xm),   x = local clock in ms, b = drift.

const ROUNDS = 10, SAMPLES = 8, EVERY = 30_000;
const rounds = [];
const events = new EventTarget();
let a = 0, b = 0, xm = 0, sigma = NaN, busy = false, last = 0, state = "measuring";

const local = () => performance.timeOrigin + performance.now();

async function round() {
  let best = { rtt: Infinity };
  for (let i = 0; i < SAMPLES; i++) {
    const x0 = local();
    const res = await fetch("/time", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const server = +await res.text();
    const x1 = local(), mid = (x0 + x1) / 2;
    if (!res.ok || !Number.isFinite(server)) throw new Error("invalid response");
    if (x1 - x0 < best.rtt) best = { rtt: x1 - x0, x: mid, y: server - mid };
  }
  return best;
}

function fit() {
  const n = rounds.length;
  xm = rounds.reduce((s, r) => s + r.x, 0) / n;
  a = rounds.reduce((s, r) => s + r.y, 0) / n;
  b = 0;
  const sxx = rounds.reduce((s, r) => s + (r.x - xm) ** 2, 0);
  // ponytail: only with ≥ 60 s of history and drift clamped to ±200 ppm; before that the slope is noise
  if (n >= 3 && rounds[n - 1].x - rounds[0].x >= 60_000)
    b = Math.max(-2e-4, Math.min(2e-4, rounds.reduce((s, r) => s + (r.x - xm) * (r.y - a), 0) / sxx));
  sigma = n >= 3 ? Math.sqrt(rounds.reduce((s, r) => s + (r.y - a - b * (r.x - xm)) ** 2, 0) / n) : NaN;
}

async function sync() {
  if (busy) return;
  busy = true;
  try {
    rounds.push(await round());
    if (rounds.length > ROUNDS) rounds.shift();
    fit();
    last = performance.now();
    state = "ok";
  } catch {
    state = "error"; // keeps the last sync
  } finally {
    busy = false;
    events.dispatchEvent(new Event("change"));
  }
}

export const clock = {
  events,
  // Server time right now (Unix ms).
  now() { const x = local(); return x + a + b * (x - xm); },
  // Local clock (ms) at which the server clock reads u (Unix ms): the inverse of now().
  localAt: u => (u - a + b * xm) / (1 + b),
  start() { sync(); setInterval(sync, EVERY); }, // network only; beat timing comes from the audio clock
  stats() {
    const rtt = rounds.at(-1)?.rtt;
    return {
      state, rtt, n: rounds.length, max: ROUNDS, last, sigma, drift: b,
      rttMin: rounds.length ? Math.min(...rounds.map(r => r.rtt)) : undefined,
      offset: rounds.length ? a + b * (local() - xm) : undefined,
    };
  },
};
