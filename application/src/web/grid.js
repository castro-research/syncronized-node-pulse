// Beat grid of a room: beat n falls on t0 + n · 60000 / bpm  (ms).
//
//   T = 60000 / bpm        n = ⌊(t − t0) / T⌋ + 1        beat = t0 + n · T
//
// Done in exact integers up to the last step, which rounds once to a double (error ≤ 122 ns).
// Requires an integer bpm and (t − t0) · bpm < 2^53 (about 10 years at 240 BPM).
// Checked against rational arithmetic in test/grid.mjs.
const M = 60000;

// Integer division with an exact remainder, correcting the double rounding error.
function divmod(a, b) {
  let q = Math.floor(a / b), r = a - q * b;
  if (r < 0) { q--; r += b } else if (r >= b) { q++; r -= b }
  return [q, r];
}

// Index of the first beat strictly after t (ms). Before t0 it is beat 0.
export function beatAfter(t0, bpm, t) {
  if (t < t0) return 0;
  const e = t - t0, ei = Math.floor(e), ef = e - ei;
  const [q, r] = divmod(ei * bpm, M);
  return q + 1 + (r + ef * bpm >= M ? 1 : 0);
}

// Instant (ms) of beat n.
export function beatTime(t0, bpm, n) {
  const [q, r] = divmod(n * M, bpm);
  return t0 + q + r / bpm;
}
