// Glyph atlas: characters rasterised once into a small 2D canvas, uploaded as a texture,
// and drawn as textured quads. The only CPU pixels are the atlas itself, never the frame.

export const FONT_STACK = 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';

/** Builds an atlas for `chars` at `px` pixels. Returns { canvas, width, height, px, glyphs: Map } */
export function buildAtlas(chars, px, weight = 600) {
  const font = `${weight} ${px}px ${FONT_STACK}`;
  const probe = new OffscreenCanvas(1, 1).getContext("2d");
  probe.font = font;
  const pad = Math.ceil(px * 0.1) + 1;
  const m = probe.measureText("Mg");
  const ascent = Math.ceil(m.fontBoundingBoxAscent ?? px * 0.8);
  const descent = Math.ceil(m.fontBoundingBoxDescent ?? px * 0.2);
  const cellH = ascent + descent + 2 * pad;
  const list = [...new Set(chars)];
  const widths = list.map(c => Math.ceil(probe.measureText(c).width));
  const cellW = Math.max(...widths) + 2 * pad;
  const cols = Math.max(1, Math.floor(2048 / cellW));
  const rows = Math.ceil(list.length / cols);

  const canvas = new OffscreenCanvas(cols * cellW, rows * cellH);
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  const glyphs = new Map();
  list.forEach((c, i) => {
    const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
    ctx.fillText(c, x + pad, y + pad + ascent);
    glyphs.set(c, { x, y, w: cellW, h: cellH, advance: probe.measureText(c).width });
  });
  return { canvas, width: canvas.width, height: canvas.height, px, pad, ascent, cellH, glyphs };
}

/** Width in pixels of `str` set in `atlas`. */
export const textWidth = (atlas, str) =>
  [...str].reduce((w, c) => w + (atlas.glyphs.get(c)?.advance ?? 0), 0);
