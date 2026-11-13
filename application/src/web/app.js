// Web Components, no build step: <pulse-app> (routing), <pulse-home>, <pulse-room> and <pulse-footer>.
// Static HTML goes in through innerHTML; anything that comes from a user goes in through textContent.
import { clock } from "./clock.js";
import { Metronome } from "./metronome.js";

const store = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
};

async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(path, {
    method, cache: "no-store", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
  return res.json();
}

const go = path => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")) };

const NS = "http://www.w3.org/2000/svg";
const svg = (name, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  e.append(...kids);
  return e;
};

// QR code as SVG (black on white, so it also scans well on the dark theme).
function qrSvg(text) {
  const q = qrcode(0, "M"), m = 4;
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), size = n + 2 * m;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return svg("svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": "Room QR code" },
    svg("rect", { width: size, height: size, fill: "#fff" }), svg("path", { d, fill: "#000" }));
}

// Decorative wave on the home screen: thin curves between two outlines that meet at both ends.
function wave() {
  const W = 400, H = 240, N = 46, P = 90;
  const g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
  const top = x => .62 - .5 * g(x, .34, .14) - .2 * g(x, .88, .09);
  const bottom = x => .62 + .28 * g(x, .6, .16);
  const grad = svg("linearGradient", { id: "wv" },
    svg("stop", { offset: "0", "stop-color": "#2aa1ff" }), svg("stop", { offset: ".55", "stop-color": "#2d3bff" }), svg("stop", { offset: "1", "stop-color": "#8a4bff" }));
  const paths = [];
  for (let k = 0; k < N; k++) {
    const s = k / (N - 1);
    let d = "";
    for (let i = 0; i <= P; i++) {
      const x = i / P, y = top(x) + (bottom(x) - top(x)) * s + .012 * Math.sin(14 * x + 7 * s) * g(x, .5, .35);
      d += `${i ? "L" : "M"}${(x * W).toFixed(1)} ${(y * H).toFixed(1)}`;
    }
    paths.push(svg("path", { d, fill: "none", stroke: "url(#wv)", "stroke-width": ".7", opacity: ".8" }));
  }
  return svg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" }, svg("defs", {}, grad), ...paths);
}

const ICON = {
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>`,
  qr: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm9-2h3v3h-3v-3zm4 0h3v3h-3v-3zm-4 4h3v3h-3v-3zm4 1h3v2h-3v-2z"/></svg>`,
  play: `<svg class="start" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg class="pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>`,
  info: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h3v10H5V9zm5.5-5h3v15h-3V4zM16 13h3v6h-3v-6z"/></svg>`,
};

customElements.define("pulse-app", class extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<main></main><pulse-footer></pulse-footer>`;
    addEventListener("popstate", () => this.#route());
    this.#route();
    clock.start();
  }

  #route() {
    const m = location.pathname.match(/^\/(?:room|sala)\/([0-9a-f-]{36})$/i); // /sala/ is the old path
    const view = document.createElement(m ? "pulse-room" : "pulse-home");
    if (m) view.setAttribute("room", m[1].toLowerCase());
    this.querySelector("main").replaceChildren(view);
  }
});

customElements.define("pulse-home", class extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="hero"></div>
      <div class="stage">
        <h1>Hi, <span data-who>guest</span></h1>
        <p class="muted">Create a room and share the link or the QR code: everyone hears the click on the same beat.</p>
        <form>
          <label>Your name <input name="who" maxlength="40" autocomplete="nickname" placeholder="guest"></label>
          <button class="primary">Create room</button>
          <p class="error" role="alert" hidden></p>
        </form>
      </div>`;
    this.querySelector(".hero").append(wave());
    const form = this.querySelector("form"), who = this.querySelector("[data-who]"), err = this.querySelector(".error");
    const show = () => { who.textContent = form.who.value.trim() || "guest" };
    form.who.value = store.get("pulse:name") ?? "";
    form.who.addEventListener("input", show);
    show();
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const name = form.who.value.trim() || "guest";
      store.set("pulse:name", name);
      try {
        go(`/room/${(await api("/api/rooms", { owner: name })).id}`);
      } catch {
        err.textContent = "Could not create the room. Please try again.";
        err.hidden = false;
      }
    });
  }
});

customElements.define("pulse-room", class extends HTMLElement {
  #metro = new Metronome();
  #id; #who; #state; #poll; #raf;
  #apply = () => {}; // set in #render, once the elements exist
  #keys = () => {};

  connectedCallback() {
    this.#id = this.getAttribute("room");
    this.#who = store.get("pulse:name");
    this.#who ? this.#enter() : this.#askName();
  }

  disconnectedCallback() {
    clearInterval(this.#poll);
    cancelAnimationFrame(this.#raf);
    removeEventListener("keydown", this.#keys);
    this.#metro.stop();
  }

  // Whoever arrives through the QR code has no name yet.
  #askName() {
    this.innerHTML = `
      <div class="stage">
        <h1>Join the room</h1>
        <form>
          <label>Your name <input name="who" maxlength="40" autocomplete="nickname" placeholder="guest"></label>
          <button class="primary">Join</button>
        </form>
      </div>`;
    this.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      this.#who = e.target.who.value.trim() || "guest";
      store.set("pulse:name", this.#who);
      this.#enter();
    });
  }

  async #enter() {
    let room;
    try {
      room = await api(`/api/rooms/${this.#id}?who=${encodeURIComponent(this.#who)}`);
    } catch (e) {
      const gone = e.status === 404;
      this.innerHTML = `
        <div class="stage">
          <h1>${gone ? "Room not found" : "Can't reach the server"}</h1>
          <p class="muted">${gone ? "The link may have expired." : "Try again in a moment."}</p>
          <a href="/">Back to home</a>
        </div>`;
      return;
    }
    this.#render(room);
  }

  #render(room) {
    this.classList.add("joined");
    this.innerHTML = `
      <header class="top">
        <a class="icon" href="/" aria-label="Back to home">${ICON.chevron}</a>
        <h1 data-title></h1>
        <button type="button" class="icon" data-qr aria-label="Show the room QR code" title="QR code">${ICON.qr}</button>
      </header>
      <div class="stage">
        <div class="beats" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <div class="sig">4/4</div>
        <div class="bpm">
          <button type="button" class="step" data-step="-1" aria-label="Decrease by 1 BPM">−</button>
          <div class="num"><output data-out></output><span>BPM</span></div>
          <button type="button" class="step" data-step="1" aria-label="Increase by 1 BPM">+</button>
        </div>
        <input type="range" min="30" max="240" step="1" data-bpm aria-label="Room BPM">
        <button type="button" class="play" data-toggle aria-label="Start" aria-keyshortcuts="Space" title="Start (Space)">${ICON.play}${ICON.pause}</button>
        <p class="muted who" data-members></p>
        <p class="hints muted"><kbd>Space</kbd> start or stop · <kbd>←</kbd> <kbd>→</kbd> BPM ±1 · <kbd>Shift</kbd> ±10</p>
      </div>
      <aside class="panel" aria-label="Room details">
        <section>
          <h2>In the room</h2>
          <ul class="members" data-list></ul>
        </section>
        <section>
          <h2>Invite</h2>
          <p class="muted">Anyone who scans the QR code or opens the link joins this room.</p>
          <div class="qr" data-qrpanel></div>
          <div class="row"><input readonly data-link aria-label="Room link"><button type="button" class="ghost" data-copy>Copy</button></div>
          <p class="muted" data-hint hidden>You opened this on localhost: other devices cannot use this link. Open it through the network address or the public domain.</p>
        </section>
      </aside>
      <dialog data-dlg>
        <h2>Join this room</h2>
        <div class="qr" data-qrbox></div>
        <p class="muted" data-hint hidden>You opened this on localhost: other devices cannot use this link. Open it through the network address or the public domain.</p>
        <div class="row"><input readonly data-link aria-label="Room link"><button type="button" class="ghost" data-copy>Copy</button></div>
        <button type="button" class="ghost" data-close>Close</button>
      </dialog>`;
    const $ = s => this.querySelector(s);
    const bpm = $("[data-bpm]"), out = $("[data-out]"), toggle = $("[data-toggle]"), dlg = $("[data-dlg]");
    const link = `${location.origin}/room/${room.id}`;
    $("[data-title]").textContent = `${room.owner}’s room`;
    // The link shows up twice: in the dialog (phone) and in the side panel (desktop).
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    for (const el of this.querySelectorAll("[data-link]")) el.value = link;
    for (const el of this.querySelectorAll("[data-hint]")) el.hidden = !local;
    $("[data-qrpanel]").replaceChildren(qrSvg(link));
    for (const b of this.querySelectorAll("[data-copy]"))
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(link) } catch { return b.previousElementSibling.select() }
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy" }, 1500);
      };

    $("[data-qr]").onclick = () => { $("[data-qrbox]").replaceChildren(qrSvg(link)); dlg.showModal() };
    $("[data-close]").onclick = () => dlg.close();
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close() }); // click on the backdrop

    // BPM: the slider and the − and + buttons change the value; a moment later it goes to the server
    // and everyone in the room hears it. Until that request finishes, polling does not undo it.
    let sending = 0;
    const show = () => { out.textContent = bpm.value; bpm.style.setProperty("--p", `${(bpm.value - 30) / 2.1}%`) };
    const send = () => {
      clearTimeout(sending);
      sending = setTimeout(() => api(`/api/rooms/${this.#id}`, { bpm: +bpm.value, who: this.#who }, "PUT")
        .then(r => this.#apply(r)).catch(() => {}).finally(() => { sending = 0 }), 250);
    };
    bpm.oninput = show;
    bpm.onchange = send;
    const nudge = d => { bpm.value = Math.min(240, Math.max(30, +bpm.value + d)); show(); send() };
    for (const b of this.querySelectorAll("[data-step]")) b.onclick = () => nudge(+b.dataset.step);

    toggle.onclick = async () => {
      if (this.#metro.playing) this.#metro.stop(); else await this.#metro.start();
      const on = this.#metro.playing;
      toggle.toggleAttribute("data-on", on);
      toggle.setAttribute("aria-label", on ? "Stop" : "Start");
      toggle.title = on ? "Stop (Space)" : "Start (Space)";
    };

    // Keyboard shortcuts: Space starts or stops, arrows change the BPM (Shift: in steps of 10).
    // Skipped while focus is on a field or button (where Space and arrows already do something,
    // so it would fire twice) and while any dialog is open.
    this.#keys = e => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || document.querySelector("dialog[open]")) return;
      if (e.target.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (e.key === " ") { e.preventDefault(); toggle.click() }
      else if (d) { e.preventDefault(); nudge(d * (e.shiftKey ? 10 : 1)) }
    };
    addEventListener("keydown", this.#keys);

    this.#apply = r => {
      if (this.#state && r.t0 < this.#state.t0) return; // late response from an older poll
      if (!this.#state || r.t0 !== this.#state.t0 || r.bpm !== this.#state.bpm) this.#metro.set({ t0: r.t0, bpm: r.bpm });
      this.#state = r;
      if (!sending && document.activeElement !== bpm) { bpm.value = r.bpm; show() }
      $("[data-members]").textContent = `In the room: ${r.members.join(", ")}`;
      $("[data-list]").replaceChildren(...r.members.map(name => {
        const li = document.createElement("li"), avatar = document.createElement("span"), label = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = [...name][0].toUpperCase();
        label.textContent = name === this.#who ? `${name} (you)` : name;
        li.append(avatar, label);
        return li;
      }));
    };
    this.#apply(room);

    this.#poll = setInterval(() => api(`/api/rooms/${this.#id}?who=${encodeURIComponent(this.#who)}`).then(r => this.#apply(r)).catch(() => {}), 1000);
    const dots = [...this.querySelectorAll(".beats span")];
    let last = -2;
    const tick = () => {
      const i = this.#metro.beat();
      if (i !== last) { last = i; dots.forEach((d, k) => d.classList.toggle("on", k === i)) }
      this.#raf = requestAnimationFrame(tick);
    };
    tick();
  }
});

// "-0.0" helps nobody.
const fmt = (v, digits = 1, unit = "") => Number.isFinite(v) ? `${v.toFixed(digits).replace(/^-(0(\.0+)?)$/, "$1")}${unit}` : "—";

customElements.define("pulse-footer", class extends HTMLElement {
  #timer;

  connectedCallback() {
    this.innerHTML = `
      <footer>
        <a class="brand" href="/">Global Metronome</a>
        <nav>
          <a href="#" data-open="about">${ICON.info}<span>How it works</span></a>
          <a href="#" data-open="stats">${ICON.chart}<span>Stats</span></a>
        </nav>
      </footer>
      <dialog data-dlg="about">
        <h2>How it works</h2>
        <p>Everyone in the room knows two things: the instant <b>t₀</b> at which the BPM was set (on the server clock) and the <b>BPM</b>. That pins the beats to a fixed grid, and each device works out the next beat on its own, with no message exchanged per click.</p>
        <pre>T = 60000 / BPM            (ms between beats)
n = ⌊(t − t₀) / T⌋ + 1       (next beat)
beat = t₀ + n · T</pre>
        <p><b>t</b> is the current time on the server clock. Each device sets its clock over HTTP: 8 requests to <code>/time</code> per round, keeping the sample with the shortest round trip (the error is at most half of it), and a linear regression over the last 10 rounds also estimates the drift of the local clock. The arithmetic uses exact integers and rounds only once at the end (122 ns maximum error).</p>
        <h3>The paper behind it</h3>
        <p><a href="https://nime.org/proceedings/2016/nime2016_paper0006.pdf" target="_blank" rel="noopener noreferrer"><i>The Global Metronome: Absolute Tempo Sync For Networked Musical Performance</i></a>, by Reid Oda and Rebecca Fiebrink (NIME 2016, <a href="https://doi.org/10.5281/zenodo.1176096" target="_blank" rel="noopener noreferrer">DOI 10.5281/zenodo.1176096</a>).</p>
        <p class="muted">In the paper the phase is the fractional part of t/T with t in Unix time, that is, a metronome "running since 1970"; here the start is the room’s t₀, equivalent to the paper’s phase offset θ. The paper syncs clocks through GPS or NTP on a local network; here the sync is over HTTP, which assumes a symmetric round trip and can be off by several milliseconds. The 4/4 bar with a higher-pitched first beat is our own addition.</p>
        <button type="button" class="ghost" data-close>Close</button>
      </dialog>
      <dialog data-dlg="stats">
        <h2>Stats</h2>
        <table>
          <tr><th>Status</th><td data-k="state"></td></tr>
          <tr><th>Round trip (last round)</th><td data-k="rtt"></td></tr>
          <tr><th>Shortest round trip</th><td data-k="rttMin"></td></tr>
          <tr><th>Maximum sync error</th><td data-k="error"></td></tr>
          <tr><th>Clock offset (server − local)</th><td data-k="offset"></td></tr>
          <tr><th>Local clock drift</th><td data-k="drift"></td></tr>
          <tr><th>Noise (σ of the residuals)</th><td data-k="sigma"></td></tr>
          <tr><th>Rounds in the regression</th><td data-k="n"></td></tr>
          <tr><th>Last sync</th><td data-k="last"></td></tr>
        </table>
        <p class="muted">The maximum error is half the round trip, the guaranteed worst case. The difference between the outbound and the return time (route asymmetry) shows up in none of these numbers.</p>
        <button type="button" class="ghost" data-close>Close</button>
      </dialog>`;

    const stats = this.querySelector('[data-dlg="stats"]');
    const render = () => {
      const s = clock.stats(), set = (k, v) => { this.querySelector(`[data-k="${k}"]`).textContent = v };
      set("state", { ok: "in sync", measuring: "measuring…", error: "server not responding" }[s.state]);
      set("rtt", fmt(s.rtt, 1, " ms"));
      set("rttMin", fmt(s.rttMin, 1, " ms"));
      set("error", Number.isFinite(s.rtt) ? `± ${fmt(s.rtt / 2, 1, " ms")}` : "—");
      set("offset", fmt(s.offset, 1, " ms"));
      set("drift", fmt(s.drift * 1e6, 0, " ppm"));
      set("sigma", fmt(s.sigma, 2, " ms"));
      set("n", `${s.n} of ${s.max}`);
      set("last", s.last ? `${Math.round((performance.now() - s.last) / 1000)} s ago` : "—");
    };
    clock.events.addEventListener("change", () => stats.open && render());
    stats.addEventListener("close", () => clearInterval(this.#timer));

    for (const link of this.querySelectorAll("[data-open]")) {
      link.onclick = e => {
        e.preventDefault();
        const dlg = this.querySelector(`[data-dlg="${link.dataset.open}"]`);
        dlg.showModal();
        if (dlg === stats) { render(); this.#timer = setInterval(render, 1000) } // keeps "X s ago" fresh
      };
    }
    for (const dlg of this.querySelectorAll("dialog")) {
      dlg.querySelector("[data-close]").onclick = () => dlg.close();
      dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close() });
    }
  }
});
