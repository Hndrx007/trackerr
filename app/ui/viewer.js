// The viewer: shows frames through the same renderer the export uses, at display size.
// Paused: exact frames from the decoder, by index. Playing: a hidden <video> element (with the
// song) drives playback, and requestVideoFrameCallback hands each presented frame to the
// renderer, mapped to a frame index through the source's timestamp table. The overlay drawn is
// always the one for the frame on screen.
import { Renderer } from "../render/renderer.js";
import { frameReader } from "../media.js";

export class Viewer {
  /** @param {{ stage: HTMLElement, canvas: HTMLCanvasElement, overlay?: (o, index) => void }} o */
  constructor({ stage, canvas, overlay }) {
    this.stage = stage;
    this.canvas = canvas;
    this.overlay = overlay;
    this.renderer = new Renderer(canvas);
    this.info = null;
    this.read = null;
    this.current = null;   // the decoded sample on screen while paused
    this.index = -1;
    this.want = -1;
    this.busy = false;
    this.onError = null;
    this.onPlayFrame = null;   // (index) → void, while playing
    this.onPlayState = null;   // (playing) → void
    // In the page but practically invisible: Chrome only runs requestVideoFrameCallback for
    // videos it composites, so a detached element would play without ever handing us frames.
    this.video = Object.assign(document.createElement("video"), { playsInline: true, preload: "auto" });
    this.video.setAttribute("aria-hidden", "true");
    Object.assign(this.video.style, { position: "absolute", left: "0", bottom: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none" });
    stage.append(this.video);
    this.url = null;
    this.playing = false;
    new ResizeObserver(() => this.layout()).observe(stage);
  }

  setSource(source, file) {
    this.pause();
    this.clear();
    this.info = source?.info ?? null;
    this.read = source ? frameReader(source) : null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = file ? URL.createObjectURL(file) : null;
    this.video.src = this.url ?? "";
    this.canvas.hidden = !source;
    this.layout();
  }

  clear() {
    this.current?.close();
    this.current = null;
    this.index = this.want = -1;
  }

  /** Shows frame `index` exactly (decoder path). Rapid calls coalesce: only the latest is decoded. */
  async show(index) {
    if (this.playing) { this.seekPlaying(index); return; }
    this.want = index;
    if (this.busy || !this.read) return;
    this.busy = true;
    try {
      while (this.read && this.want !== this.index && !this.playing) {
        const i = this.want, read = this.read;
        const sample = await read(i);
        if (read !== this.read || this.playing) { sample?.close(); break; }
        if (!sample) break;
        this.current?.close();
        this.current = sample;
        this.index = i;
        this.draw();
      }
    } catch (e) {
      this.onError?.(e);
    } finally {
      this.busy = false;
    }
  }

  /** Redraws the frame on screen (e.g. after a parameter changed). */
  draw() {
    if (this.playing || !this.current) return;
    this.renderer.render(this.current, this.overlay ? o => this.overlay(o, this.index) : null);
  }

  /* ---------------- playback ---------------- */

  async play() {
    if (this.playing || !this.info || !this.url) return;
    const ts = this.info.timestamps, i = Math.max(0, this.index);
    this.video.currentTime = ts[Math.min(i, ts.length - 1)] + 1e-4;
    this.playing = true;
    this.onPlayState?.(true);
    try { await this.video.play(); }
    catch (e) {
      // AbortError: the seek above interrupted play(); one retry once it has settled.
      if (e.name === "AbortError" && this.playing) {
        try { await this.video.play(); } catch (e2) { e = e2; }
      }
      if (this.video.paused) { this.playing = false; this.onPlayState?.(false); this.onError?.(e); return; }
    }
    let shown = -1;
    const tick = (now, meta) => {
      if (!this.playing) return;
      const idx = this.#indexFor(meta.mediaTime);
      if (idx === shown) { this.video.requestVideoFrameCallback(tick); return; }   // same frame again: nothing to redraw
      shown = idx;
      let vf = null;
      try {
        vf = new VideoFrame(this.video, { timestamp: Math.round(meta.mediaTime * 1e6) });
        this.renderer.render(vf, this.overlay ? o => this.overlay(o, idx) : null);
      } catch (e) { this.onError?.(e); }
      finally { vf?.close(); }
      this.index = idx;
      this.onPlayFrame?.(idx);
      if (idx >= this.info.frameCount - 1) { this.pause(); return; }
      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
    this.video.onended = () => this.pause();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.video.pause();
    this.onPlayState?.(false);
    // Settle on the exact decoded frame for the index that was showing.
    const i = this.index;
    this.current?.close(); this.current = null;
    this.index = -1;
    if (i >= 0) this.show(i);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seekPlaying(index) {
    const ts = this.info.timestamps;
    this.video.currentTime = ts[Math.max(0, Math.min(ts.length - 1, index))] + 1e-4;
  }

  // Nearest frame in the timestamp table (binary search).
  #indexFor(t) {
    const ts = this.info.timestamps;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t) ? lo - 1 : lo;
  }

  // Fit the canvas to the stage at the source aspect, in device pixels, never above source size.
  layout() {
    if (!this.info) return;
    const pad = 16, dpr = devicePixelRatio || 1;
    const sw = this.stage.clientWidth - pad * 2, sh = this.stage.clientHeight - pad * 2;
    if (sw <= 0 || sh <= 0) return;
    const k = Math.min(sw / this.info.width, sh / this.info.height);
    const cssW = Math.floor(this.info.width * k), cssH = Math.floor(this.info.height * k);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.renderer.setSize(
      Math.min(this.info.width, Math.round(cssW * dpr)),
      Math.min(this.info.height, Math.round(cssH * dpr)));
    this.draw();
  }
}
