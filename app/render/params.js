// Parameters as data. The panel is generated from this list, presets are named sets of values,
// and composition and rendering read nothing else. The main panel holds look decisions; the
// algorithm internals sit under Advanced.
//
// Entry: { key, label, type, default, min, max, step, group, advanced, options, unit, hint }
//   type: "range" | "select" | "toggle" | "text" | "colour"

export const GROUPS = ["Look", "Hero", "Swarm", "Motion", "Connectors", "Tracking"];

export const PARAMS = [
  // Look
  { key: "preset", label: "Look", type: "select", group: "Look", default: "surveillance", options: [] /* filled from PRESETS */ },
  { key: "colour", label: "HUD colour", type: "colour", group: "Look", default: "#ff2a1f" },
  { key: "intensity", label: "Overall intensity", type: "range", group: "Look", default: 1, min: 0, max: 1, step: 0.01 },
  { key: "chrome", label: "Frame marks and REC readout", type: "toggle", group: "Look", default: true },

  // Hero
  { key: "palette", label: "Thermal palette", type: "select", group: "Hero", default: "inferno", options: [["inferno", "Inferno"], ["iron", "Iron"], ["whitehot", "White-hot"]] },
  { key: "gain", label: "Thermal gain", type: "range", group: "Hero", default: 1.15, min: 0.5, max: 2, step: 0.01 },
  { key: "contrast", label: "Thermal contrast", type: "range", group: "Hero", default: 1.35, min: 0.5, max: 3, step: 0.01 },
  { key: "heroBox", label: "Hero box", type: "select", group: "Hero", default: "both", options: [["both", "Box and brackets"], ["brackets", "Brackets only"], ["box", "Box only"]] },
  { key: "bracket", label: "Bracket length", type: "range", group: "Hero", default: 0.22, min: 0.05, max: 0.5, step: 0.01, hint: "fraction of the hero box's shorter side" },
  { key: "heroStroke", label: "Hero line weight", type: "range", group: "Hero", default: 0.0035, min: 0.001, max: 0.01, step: 0.0001, hint: "fraction of frame height" },
  { key: "label", label: "Label text", type: "text", group: "Hero", default: "THERMAL: ON" },
  { key: "labelSize", label: "Label size", type: "range", group: "Hero", default: 0.028, min: 0.012, max: 0.06, step: 0.001, hint: "fraction of frame height" },
  { key: "heroPad", label: "Hero box padding", type: "range", group: "Hero", default: 0.04, min: 0, max: 0.2, step: 0.005, advanced: true },
  { key: "heroSmoothing", label: "Hero smoothing", type: "range", group: "Hero", default: 3, min: 0, max: 8, step: 0.1, unit: "frames", advanced: true },

  // Swarm
  { key: "amount", label: "Amount", type: "range", group: "Swarm", default: 10, min: 0, max: 30, step: 1, hint: "most swarm boxes on screen at once" },
  { key: "focus", label: "Focus", type: "range", group: "Swarm", default: 0.55, min: 0, max: 1, step: 0.01, hint: "0 spread across the frame · 1 gathered around the hero" },
  { key: "lockCount", label: "Lock boxes", type: "range", group: "Swarm", default: 3, min: 0, max: 6, step: 1 },
  { key: "scanStyle", label: "Scan box style", type: "select", group: "Swarm", default: "lines", options: [["lines", "Box with scanlines"], ["corners", "Corners with scanlines"], ["plain", "Thin box"]] },
  { key: "lockStyle", label: "Lock box style", type: "select", group: "Swarm", default: "brackets", options: [["brackets", "Heavy brackets"], ["box", "Heavy box"], ["reticle", "Reticle"]] },
  { key: "trace", label: "Trace tier", type: "select", group: "Swarm", default: "off", options: [["off", "Off"], ["ticks", "Ticks"], ["points", "Points"]] },
  { key: "scanlines", label: "Scanline density", type: "range", group: "Swarm", default: 0.5, min: 0, max: 1, step: 0.01 },
  { key: "readout", label: "Readout", type: "select", group: "Swarm", default: "telemetry", options: [["telemetry", "Telemetry"], ["id", "Track ID"], ["class", "Class label"], ["distance", "Distance to hero"], ["confidence", "Confidence"], ["off", "Off"]] },
  { key: "maxSize", label: "Largest box", type: "range", group: "Swarm", default: 0.45, min: 0.1, max: 1, step: 0.01, advanced: true, hint: "fraction of the hero box's height" },
  { key: "minBox", label: "Smallest box", type: "range", group: "Swarm", default: 0.035, min: 0.01, max: 0.1, step: 0.001, advanced: true, hint: "fraction of frame height" },
  { key: "exclusion", label: "Hero exclusion margin", type: "range", group: "Swarm", default: 0.06, min: 0, max: 0.3, step: 0.005, advanced: true, hint: "fraction of frame height around the hero" },
  { key: "spacing", label: "Minimum spacing", type: "range", group: "Swarm", default: 0.035, min: 0, max: 0.15, step: 0.001, advanced: true, hint: "fraction of frame height between boxes" },
  { key: "wMotion", label: "Weight: motion", type: "range", group: "Swarm", default: 0.8, min: 0, max: 2, step: 0.01, advanced: true },
  { key: "wAge", label: "Weight: persistence", type: "range", group: "Swarm", default: 1, min: 0, max: 2, step: 0.01, advanced: true },
  { key: "wSize", label: "Weight: size", type: "range", group: "Swarm", default: 0.6, min: 0, max: 2, step: 0.01, advanced: true },
  { key: "wPerson", label: "Weight: other people", type: "range", group: "Swarm", default: 1.2, min: 0, max: 3, step: 0.01, advanced: true },
  { key: "swarmSmoothing", label: "Swarm smoothing", type: "range", group: "Swarm", default: 1.5, min: 0, max: 6, step: 0.1, unit: "frames", advanced: true },

  // Motion
  { key: "acquire", label: "Acquire speed", type: "range", group: "Motion", default: 0.25, min: 0.04, max: 1, step: 0.01, unit: "s" },
  { key: "release", label: "Release speed", type: "range", group: "Motion", default: 0.18, min: 0.04, max: 1, step: 0.01, unit: "s" },
  { key: "sequence", label: "Shot-start sequence", type: "toggle", group: "Motion", default: true },
  { key: "seqHero", label: "Hero acquired after", type: "range", group: "Motion", default: 0.35, min: 0, max: 2, step: 0.01, unit: "s" },
  { key: "seqThermal", label: "Thermal switches on after", type: "range", group: "Motion", default: 0.8, min: 0, max: 3, step: 0.01, unit: "s" },
  { key: "seqWipe", label: "Thermal wipe length", type: "range", group: "Motion", default: 0.3, min: 0.04, max: 1.5, step: 0.01, unit: "s" },
  { key: "hysteresis", label: "Promotion hysteresis", type: "range", group: "Motion", default: 0.4, min: 0, max: 2, step: 0.01, unit: "s", advanced: true, hint: "a challenger must outscore a visible box this long" },
  { key: "minVisible", label: "Minimum visible time", type: "range", group: "Motion", default: 0.75, min: 0, max: 3, step: 0.01, unit: "s", advanced: true },

  // Connectors
  { key: "connectors", label: "Connectors", type: "toggle", group: "Connectors", default: true },
  { key: "connectTiers", label: "Connect", type: "select", group: "Connectors", default: "lock", options: [["lock", "Lock boxes"], ["lockscan", "Lock and scan boxes"]] },
  { key: "connectRange", label: "Range", type: "range", group: "Connectors", default: 0.6, min: 0.1, max: 1.5, step: 0.01, hint: "fraction of frame width" },
  { key: "connectWeight", label: "Weight", type: "range", group: "Connectors", default: 0.0022, min: 0.0005, max: 0.008, step: 0.0001, hint: "fraction of frame height" },

  // Tracking
  { key: "autoPick", label: "Auto-pick hero per shot", type: "toggle", group: "Tracking", default: true },
  { key: "detectConf", label: "Detection confidence", type: "range", group: "Tracking", default: 0.35, min: 0.1, max: 0.9, step: 0.01, advanced: true, hint: "takes effect on the next analysis" },
  { key: "detectStride", label: "Detect every", type: "range", group: "Tracking", default: 1, min: 1, max: 4, step: 1, unit: "frames", advanced: true, hint: "takes effect on the next analysis" },
];

export const PARAM = Object.fromEntries(PARAMS.map(p => [p.key, p]));
export const defaults = () => Object.fromEntries(PARAMS.map(p => [p.key, p.default]));

/**
 * Built-in looks. They differ in composition and choreography, not only colour.
 * Each lists only what it changes from the defaults.
 */
export const PRESETS = {
  surveillance: {
    name: "Surveillance",
    purpose: "The notebook's red look, done well: scanlines, connectors to the hero, moderate density.",
    values: {},
  },
  lockon: {
    name: "Lock-on",
    purpose: "Sparse and deliberate: a few heavy lock boxes with readouts, strong connectors, the full shot-start sequence.",
    values: {
      colour: "#ff3b2f", amount: 5, lockCount: 4, focus: 0.75, lockStyle: "brackets", scanStyle: "plain",
      scanlines: 0.2, readout: "telemetry", connectTiers: "lock", connectWeight: 0.0035, connectRange: 0.9,
      acquire: 0.35, release: 0.25, sequence: true, seqHero: 0.5, seqThermal: 1.0, seqWipe: 0.45,
      heroBox: "brackets", bracket: 0.3, heroStroke: 0.005, minVisible: 1.2, hysteresis: 0.8,
    },
  },
  scan: {
    name: "Scan",
    purpose: "Denser and fainter: mostly scan boxes and trace ticks, few locks, no connectors. Reads as a sweep of the whole frame.",
    values: {
      colour: "#ff4d3d", intensity: 0.8, amount: 18, lockCount: 1, focus: 0.15, scanStyle: "corners",
      scanlines: 0.75, trace: "ticks", readout: "id", connectors: false, acquire: 0.15, release: 0.12,
      sequence: false, spacing: 0.025, minVisible: 0.5, hysteresis: 0.3,
    },
  },
  minimal: {
    name: "Minimal",
    purpose: "Hero and thermal only, with a small readout. For shots where the swarm would be too much.",
    values: {
      amount: 0, lockCount: 0, connectors: false, trace: "off", labelSize: 0.02, heroBox: "brackets", chrome: false,
      bracket: 0.18, sequence: true, seqHero: 0.2, seqThermal: 0.45, seqWipe: 0.25,
    },
  },
  target: {
    name: "Target",
    purpose: "A proposal: one hard lock on the nearest other person, everything else a light scan field. For multi-person shots.",
    values: {
      amount: 8, lockCount: 1, wPerson: 3, focus: 0.9, lockStyle: "reticle", scanStyle: "plain",
      scanlines: 0.3, readout: "distance", connectTiers: "lock", connectWeight: 0.004, trace: "points",
    },
  },
};
PARAM.preset.options = Object.entries(PRESETS).map(([k, p]) => [k, p.name]);

/** Full parameter set for a preset (defaults plus its changes). */
export const presetValues = key => ({ ...defaults(), ...(PRESETS[key]?.values ?? {}), preset: key });

/** Keys whose value differs from the preset's, i.e. what the editor changed. */
export function modifiedKeys(params) {
  const base = presetValues(params.preset);
  return PARAMS.map(p => p.key).filter(k => k !== "preset" && params[k] !== base[k]);
}

/** Clamps and fills a parameter set (e.g. loaded from JSON). Unknown keys are dropped. */
export function sanitize(values) {
  const out = defaults();
  for (const p of PARAMS) {
    const v = values?.[p.key];
    if (v === undefined) continue;
    if (p.type === "range" && Number.isFinite(+v)) out[p.key] = Math.min(p.max, Math.max(p.min, +v));
    else if (p.type === "toggle") out[p.key] = !!v;
    else if (p.type === "select" && p.options.some(([o]) => o === v)) out[p.key] = v;
    else if ((p.type === "text" || p.type === "colour") && typeof v === "string") out[p.key] = v.slice(0, 80);
  }
  return out;
}

/** "#rrggbb" → [r, g, b] in 0..1. */
export function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  const n = m ? parseInt(m[1], 16) : 0xff2a1f;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
