// Transport: timecode, frame number, step buttons, the scrubber with cut markers, and the
// cut-signal debug graph (d(i) and the live threshold) under it. The hero lane arrives in M4.

/** Non-drop-frame timecode from a frame index, at the nominal rate (23.976 → 24). */
export function timecode(index, [num, den]) {
  const nominal = Math.round(num / den);
  const ff = index % nominal, s = Math.floor(index / nominal);
  const p = n => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

const THUMB = 16;   // px: the range input's thumb, so markers line up with the thumb's centre

export class Timeline {
  /** @param {{ root: HTMLElement, onSeek: (index: number) => void, onSelectCut?: (frame: number|null) => void }} o */
  constructor({ root, onSeek, onSelectCut }) {
    this.root = root;
    this.onSeek = onSeek;
    this.onSelectCut = onSelectCut;
    this.tc = root.querySelector("[data-tc]");
    this.fr = root.querySelector("[data-frame]");
    this.scrub = root.querySelector("[data-scrub]");
    this.total = root.querySelector("[data-total]");
    this.markersEl = root.querySelector("[data-markers]");
    this.graph = root.querySelector("[data-graph]");
    this.fps = null;
    this.count = 0;
    this.index = 0;
    this.cuts = [];           // [{ frame, origin, removed }]
    this.selected = null;
    this.signal = null;       // { d, threshold, flash }
    this.scrub.addEventListener("input", () => this.seek(+this.scrub.value));
    root.querySelector("[data-prev]").addEventListener("click", () => this.step(-1));
    root.querySelector("[data-next]").addEventListener("click", () => this.step(1));
    this.markersEl.addEventListener("click", e => {
      const m = e.target.closest("[data-cut]");
      if (!m) return;
      const f = +m.dataset.cut;
      this.select(f);
      this.seek(f);
    });
    this.graph.addEventListener("pointerdown", e => this.#graphSeek(e));
    this.graph.addEventListener("pointermove", e => { if (e.buttons & 1) this.#graphSeek(e); });
    new ResizeObserver(() => this.drawGraph()).observe(this.graph);
  }

  setClip(info) {
    this.fps = info?.fps ?? null;
    this.count = info?.frameCount ?? 0;
    this.scrub.max = Math.max(0, this.count - 1);
    this.scrub.disabled = !info;
    this.root.querySelectorAll("button").forEach(b => b.disabled = !info);
    this.total.textContent = info ? `of ${this.count.toLocaleString("en-US")}` : "";
    this.setCuts([]);
    this.setSignal(null);
    this.show(0);
  }

  /** Cut markers: [{ frame, origin: "auto" | "manual", removed: bool }]. */
  setCuts(cuts) {
    this.cuts = cuts;
    if (this.selected !== null && !cuts.some(c => c.frame === this.selected)) this.selected = null;
    const frac = f => this.count > 1 ? f / (this.count - 1) : 0;
    this.markersEl.replaceChildren(...cuts.map(c => {
      const b = document.createElement("button");
      b.className = `cut ${c.origin}${c.removed ? " removed" : ""}${c.frame === this.selected ? " sel" : ""}`;
      b.dataset.cut = c.frame;
      b.tabIndex = -1;
      b.title = `${c.removed ? "Removed auto cut" : c.origin === "manual" ? "Manual cut" : "Cut"} at frame ${c.frame.toLocaleString("en-US")}`;
      b.style.left = `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${frac(c.frame)})`;
      return b;
    }));
    this.drawGraph();
  }

  select(frame) {
    this.selected = frame;
    this.markersEl.querySelectorAll("[data-cut]").forEach(m => m.classList.toggle("sel", +m.dataset.cut === frame));
    this.onSelectCut?.(frame);
  }

  /** Cut-signal data for the graph, or null to hide it. */
  setSignal(signal) {
    this.signal = signal;
    this.graph.hidden = !signal;
    this.drawGraph();
  }

  /** One frame (±1) or, with shift, one second. */
  step(dir, second = false) {
    if (!this.count) return;
    const n = second ? Math.round(this.fps[0] / this.fps[1]) : 1;
    this.seek(this.index + dir * n);
  }

  seek(index) {
    if (!this.count) return;
    index = Math.max(0, Math.min(this.count - 1, Math.round(index)));
    this.show(index);
    this.onSeek(index);
  }

  show(index) {
    this.index = index;
    this.scrub.value = index;
    this.tc.textContent = this.fps ? timecode(index, this.fps) : "--:--:--:--";
    this.fr.textContent = this.count ? `f ${index.toLocaleString("en-US")}` : "f –";
    this.drawGraph();
  }

  #graphSeek(e) {
    const r = this.graph.getBoundingClientRect();
    const u = (e.clientX - r.left - THUMB / 2) / (r.width - THUMB);
    this.seek(u * (this.count - 1));
  }

  // d(i) as bars (max per pixel column), the threshold as a line, cuts and flashes marked,
  // and the playhead. Scale: 0 at the bottom, 1.0 (very different frames) at the top.
  drawGraph() {
    const s = this.signal, c = this.graph;
    if (!s || c.hidden || !this.count) return;
    const dpr = devicePixelRatio || 1, W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const g = c.getContext("2d"), pad = THUMB / 2 * dpr, span = W - 2 * pad, n = this.count;
    const css = getComputedStyle(document.documentElement);
    const col = v => css.getPropertyValue(v).trim();
    g.clearRect(0, 0, W, H);
    const y = v => H - 2 - Math.min(1, v) * (H - 4);
    const cols = Math.max(1, Math.floor(span));
    const dMax = new Float32Array(cols), tMin = new Float32Array(cols).fill(Infinity), flash = new Uint8Array(cols);
    for (let f = 1; f < n; f++) {
      const x = Math.min(cols - 1, Math.floor(f / (n - 1) * (cols - 1)));
      if (s.d[f] > dMax[x]) dMax[x] = s.d[f];
      if (s.threshold[f] < tMin[x]) tMin[x] = s.threshold[f];
      if (s.flash?.[f]) flash[x] = 1;
    }
    g.fillStyle = col("--faint");
    for (let x = 0; x < cols; x++) if (dMax[x] > 0) g.fillRect(pad + x, y(dMax[x]), Math.max(1, dpr * 0.8), H - 2 - y(dMax[x]));
    g.strokeStyle = col("--warn");
    g.lineWidth = dpr;
    g.beginPath();
    for (let x = 0; x < cols; x++) if (Number.isFinite(tMin[x])) g[x ? "lineTo" : "moveTo"](pad + x, y(tMin[x]));
    g.stroke();
    g.fillStyle = col("--dim");
    for (let x = 0; x < cols; x++) if (flash[x]) g.fillRect(pad + x - dpr, H - 3 * dpr, 2 * dpr, 2 * dpr);
    for (const cut of this.cuts) {
      const x = pad + cut.frame / (n - 1) * (cols - 1);
      g.fillStyle = cut.removed ? col("--faint") : cut.origin === "manual" ? col("--ok") : col("--accent");
      g.fillRect(x - dpr / 2, 0, dpr, cut.removed ? H * 0.3 : H);
    }
    g.fillStyle = col("--ink");
    g.fillRect(pad + this.index / (n - 1) * (cols - 1) - dpr / 2, 0, dpr, H);
  }
}
