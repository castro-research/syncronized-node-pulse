// Plays a room's beat grid. No setTimeout/setInterval in the beat timing: clicks are scheduled
// on the audio clock, and each click that ends schedules the next ones.
import { beatAfter, beatTime } from "./grid.js";
import { clock } from "./clock.js";

export class Metronome {
  grid = null; // { t0, bpm }
  #ctx; #playing = false; #next = 0; #queue = new Set();

  get playing() { return this.#playing }

  set(grid) {
    this.grid = grid;
    if (this.#playing) this.#retime();
  }

  // Must run inside the user gesture (click/key), otherwise Safari does not unlock audio.
  async start() {
    // iOS: without this, Web Audio stays silent while the mute switch is on
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    const ctx = this.#ctx ??= new AudioContext();
    this.#playing = true;
    this.#retime();
    // In Safari resume() can take a while or never resolve: we do not wait for it, we only
    // reschedule once the context starts (audio time stands still while it is suspended).
    if (ctx.state !== "running") ctx.resume().then(() => this.#playing && this.#retime(), () => {});
  }

  stop() {
    this.#playing = false;
    this.#clear();
  }

  // Position (0 to 3) in the bar of the last beat already played, or -1 when stopped.
  // Read from the formula on every frame, so it never drifts away from the sound.
  beat() {
    if (!this.#playing || !this.grid) return -1;
    const { t0, bpm } = this.grid;
    const t = clock.now() - (this.#ctx.outputLatency || 0) * 1000; // the sound comes out after it is scheduled
    const n = beatAfter(t0, bpm, t) - 1;
    return n < 0 ? -1 : n % 4;
  }

  #clear() {
    for (const o of this.#queue) { o.onended = null; o.stop() }
    this.#queue.clear();
  }

  #retime() {
    this.#clear();
    this.#next = beatAfter(this.grid.t0, this.grid.bpm, clock.now() + 50);
    this.#fill();
  }

  #fill() {
    if (!this.#playing) return;
    const { t0, bpm } = this.grid, ctx = this.#ctx;
    // Pair (audio time, performance.now()) of the sample leaving the speakers right now.
    // Safari sometimes returns a zeroed or frozen pair, which throws the beats far from the
    // present (silence): a pair is only trusted if it agrees with now, else currentTime is used.
    let ts = ctx.getOutputTimestamp();
    if (!ts.contextTime || Math.abs(performance.now() - ts.performanceTime) > 500 || Math.abs(ctx.currentTime - ts.contextTime) > 0.5)
      ts = { contextTime: ctx.currentTime, performanceTime: performance.now() };
    const horizon = clock.now() + Math.max(2000, 2 * 60000 / bpm);
    for (; beatTime(t0, bpm, this.#next) < horizon; this.#next++) {
      const n = this.#next;
      const when = ts.contextTime + (clock.localAt(beatTime(t0, bpm, n)) - performance.timeOrigin - ts.performanceTime) / 1000;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = n % 4 ? 800 : 1200; // the first of every 4 is higher-pitched
      gain.gain.setValueAtTime(1, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(when);
      osc.stop(when + 0.05);
      osc.onended = () => { this.#queue.delete(osc); this.#fill() };
      this.#queue.add(osc);
    }
  }
}
