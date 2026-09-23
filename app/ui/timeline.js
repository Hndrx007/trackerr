// Transport: timecode, frame number, step buttons and the scrubber.
// Cut markers, the hero lane and the cut-signal graph arrive in M2/M4.

/** Non-drop-frame timecode from a frame index, at the nominal rate (23.976 → 24). */
export function timecode(index, [num, den]) {
  const nominal = Math.round(num / den);
  const ff = index % nominal, s = Math.floor(index / nominal);
  const p = n => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export class Timeline {
  /** @param {{ root: HTMLElement, onSeek: (index: number) => void }} o */
  constructor({ root, onSeek }) {
    this.root = root;
    this.onSeek = onSeek;
    this.tc = root.querySelector("[data-tc]");
    this.fr = root.querySelector("[data-frame]");
    this.scrub = root.querySelector("[data-scrub]");
    this.total = root.querySelector("[data-total]");
    this.fps = null;
    this.count = 0;
    this.index = 0;
    this.scrub.addEventListener("input", () => this.seek(+this.scrub.value));
    root.querySelector("[data-prev]").addEventListener("click", () => this.step(-1));
    root.querySelector("[data-next]").addEventListener("click", () => this.step(1));
  }

  setClip(info) {
    this.fps = info?.fps ?? null;
    this.count = info?.frameCount ?? 0;
    this.scrub.max = Math.max(0, this.count - 1);
    this.scrub.disabled = !info;
    this.root.querySelectorAll("button").forEach(b => b.disabled = !info);
    this.total.textContent = info ? `of ${this.count.toLocaleString("en-US")}` : "";
    this.show(0);
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
  }
}
