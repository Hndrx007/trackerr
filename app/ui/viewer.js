// The viewer: shows one frame through the same renderer the export uses, at display size.
// M1 steps frame by frame; M3 adds playback from a <video> element with requestVideoFrameCallback.
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
    this.current = null;   // the decoded sample on screen
    this.index = -1;
    this.want = -1;
    this.busy = false;
    this.onError = null;
    new ResizeObserver(() => this.layout()).observe(stage);
  }

  setSource(source) {
    this.clear();
    this.info = source?.info ?? null;
    this.read = source ? frameReader(source) : null;
    this.canvas.hidden = !source;
    this.layout();
  }

  clear() {
    this.current?.close();
    this.current = null;
    this.index = this.want = -1;
  }

  /** Shows frame `index`. Rapid calls coalesce: only the latest request is decoded. */
  async show(index) {
    this.want = index;
    if (this.busy || !this.read) return;
    this.busy = true;
    try {
      while (this.read && this.want !== this.index) {
        const i = this.want, read = this.read;
        const sample = await read(i);
        if (read !== this.read) { sample?.close(); break; }  // source changed meanwhile
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

  draw() {
    if (!this.current) return;
    this.renderer.render(this.current, this.overlay ? o => this.overlay(o, this.index) : null);
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
