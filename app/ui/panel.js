// Settings panel, generated from params.js. Look decisions up front, internals under Advanced.
// Sliders show their value and reset on double-click. Presets can be previewed by hovering in
// the Look menu (the current frame re-renders), applied by clicking, and saved as the editor's own.
import { PARAMS, GROUPS, PRESETS, presetValues, modifiedKeys, sanitize } from "../render/params.js";

const STORE = "heroTracker.presets.v1";

export function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}") ?? {}; } catch { return {}; }
}
function saveUserPresets(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { /* private mode */ } }

const fmt = (p, v) => {
  if (p.type !== "range") return String(v);
  const digits = p.step >= 1 ? 0 : p.step >= 0.1 ? 1 : p.step >= 0.01 ? 2 : p.step >= 0.001 ? 3 : 4;
  return `${(+v).toFixed(digits)}${p.unit ? " " + p.unit : ""}`;
};

export class Panel {
  /**
   * @param {HTMLElement} root
   * @param {{ params: object, onChange: (params, key) => void, onPreview: (params|null) => void }} o
   */
  constructor(root, { params, onChange, onPreview }) {
    this.root = root;
    this.params = { ...params };
    this.onChange = onChange;
    this.onPreview = onPreview;
    this.user = loadUserPresets();
    this.inputs = new Map();
    this.build();
  }

  allPresets() {
    return {
      ...Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { name: p.name, purpose: p.purpose, values: presetValues(k) }])),
      ...Object.fromEntries(Object.entries(this.user).map(([k, v]) => [k, { name: v.name, purpose: "Your saved look.", values: sanitize({ ...v.values, preset: k }), user: true }])),
    };
  }

  build() {
    const r = this.root;
    r.replaceChildren();
    // Look menu with hover preview.
    const look = el("section", { className: "look" });
    look.append(el("h3", { textContent: "Look" }));
    this.lookBtn = el("button", { className: "look-btn", type: "button" });
    this.lookBtn.addEventListener("click", () => this.menu.hidden = !this.menu.hidden);
    this.menu = el("div", { className: "look-menu", hidden: true });
    look.append(this.lookBtn, this.menu);
    const row = el("div", { className: "row" });
    this.saveBtn = el("button", { textContent: "Save as my look", type: "button" });
    this.saveBtn.addEventListener("click", () => this.saveAs());
    const exp = el("button", { textContent: "Export…", type: "button", title: "Save this look as a JSON file" });
    exp.addEventListener("click", () => this.exportPreset());
    const imp = el("button", { textContent: "Import…", type: "button", title: "Load a look from a JSON file" });
    imp.addEventListener("click", () => this.importPreset());
    row.append(this.saveBtn, exp, imp);
    look.append(row, this.status = el("p", { className: "note" }));
    r.append(look);

    const adv = el("details", { className: "advanced" });
    adv.append(el("summary", { textContent: "Advanced" }));
    for (const g of GROUPS) {
      const main = PARAMS.filter(p => p.group === g && !p.advanced && p.key !== "preset");
      const more = PARAMS.filter(p => p.group === g && p.advanced);
      if (main.length) {
        const s = el("section");
        s.append(el("h3", { textContent: g }));
        for (const p of main) s.append(this.control(p));
        r.append(s);
      }
      if (more.length) {
        const s = el("div", { className: "adv-group" });
        s.append(el("h4", { textContent: g }));
        for (const p of more) s.append(this.control(p));
        adv.append(s);
      }
    }
    r.append(adv);
    this.renderMenu();
    this.sync();
  }

  control(p) {
    const wrap = el("label", { className: `ctl ctl-${p.type}` });
    const name = el("span", { className: "name", textContent: p.label });
    if (p.hint) wrap.title = p.hint;
    let input, value = null;
    if (p.type === "range") {
      input = el("input", { type: "range", min: p.min, max: p.max, step: p.step });
      value = el("span", { className: "val" });
      input.addEventListener("input", () => this.set(p.key, +input.value));
      input.addEventListener("dblclick", () => this.set(p.key, presetValues(this.params.preset)[p.key] ?? p.default));
      wrap.append(el("span", { className: "top" }, name, value), input);
    } else if (p.type === "select") {
      input = el("select");
      for (const [v, t] of p.options) input.append(el("option", { value: v, textContent: t }));
      input.addEventListener("change", () => this.set(p.key, input.value));
      wrap.append(name, input);
    } else if (p.type === "toggle") {
      input = el("input", { type: "checkbox" });
      input.addEventListener("change", () => this.set(p.key, input.checked));
      wrap.append(input, name);
    } else if (p.type === "colour") {
      input = el("input", { type: "color" });
      input.addEventListener("input", () => this.set(p.key, input.value));
      wrap.append(name, input);
    } else {
      input = el("input", { type: "text", maxLength: 40 });
      input.addEventListener("input", () => this.set(p.key, input.value));
      wrap.append(name, input);
    }
    this.inputs.set(p.key, { p, input, value });
    return wrap;
  }

  set(key, v) {
    this.params = { ...this.params, [key]: v };
    this.sync();
    this.onChange(this.params, key);
  }

  /** Replaces all values (e.g. from loaded track data or a preset). */
  setParams(params) {
    this.params = { ...params };
    this.sync();
  }

  apply(presetKey) {
    const p = this.allPresets()[presetKey];
    if (!p) return;
    this.params = { ...p.values, preset: presetKey };
    this.menu.hidden = true;
    this.sync();
    this.onPreview(null);
    this.onChange(this.params, "preset");
  }

  renderMenu() {
    const all = this.allPresets();
    this.menu.replaceChildren(...Object.entries(all).map(([k, p]) => {
      const b = el("button", { type: "button", className: "look-item" });
      b.append(el("b", { textContent: p.name }), el("span", { textContent: p.purpose }));
      b.addEventListener("mouseenter", () => this.onPreview({ ...p.values, preset: k }));
      b.addEventListener("focus", () => this.onPreview({ ...p.values, preset: k }));
      b.addEventListener("mouseleave", () => this.onPreview(null));
      b.addEventListener("click", () => this.apply(k));
      return b;
    }));
    this.menu.addEventListener("mouseleave", () => this.onPreview(null));
  }

  sync() {
    const all = this.allPresets(), cur = all[this.params.preset];
    const changed = cur ? modifiedAgainst(this.params, cur.values) : [];
    this.lookBtn.textContent = `${cur?.name ?? "Custom"}${changed.length ? " (modified)" : ""} ▾`;
    this.status.textContent = changed.length ? `Changed: ${changed.map(k => PARAMS.find(p => p.key === k)?.label.toLowerCase()).join(", ")}` : cur?.purpose ?? "";
    for (const { p, input, value } of this.inputs.values()) {
      const v = this.params[p.key];
      if (p.type === "toggle") input.checked = !!v;
      else if (document.activeElement !== input || p.type !== "text") input.value = v;
      if (value) value.textContent = fmt(p, v);
      input.closest("label").classList.toggle("changed", changed.includes(p.key));
    }
  }

  saveAs() {
    const name = prompt("Name for this look:", `${this.allPresets()[this.params.preset]?.name ?? "My look"} (mine)`);
    if (!name) return;
    const key = "user:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const values = { ...this.params };
    delete values.preset;
    this.user[key] = { name: name.slice(0, 40), values };
    saveUserPresets(this.user);
    this.params.preset = key;
    this.renderMenu();
    this.sync();
    this.onChange(this.params, "preset");
  }

  async exportPreset() {
    const name = this.allPresets()[this.params.preset]?.name ?? "look";
    const text = JSON.stringify({ heroTrackerLook: 1, name, values: this.params }, null, 2);
    try {
      const h = await showSaveFilePicker({ suggestedName: `${name.replace(/[^\w-]+/g, "_")}.look.json`, types: [{ description: "Look", accept: { "application/json": [".json"] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close();
    } catch (e) { if (e.name !== "AbortError") throw e; }
  }

  async importPreset() {
    try {
      const [h] = await showOpenFilePicker({ types: [{ description: "Look", accept: { "application/json": [".json"] } }] });
      const data = JSON.parse(await (await h.getFile()).text());
      if (!data?.values) throw new Error("not a look file");
      const name = String(data.name ?? h.name).slice(0, 40);
      const key = "user:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const values = sanitize(data.values);
      delete values.preset;
      this.user[key] = { name, values };
      saveUserPresets(this.user);
      this.renderMenu();
      this.apply(key);
    } catch (e) {
      if (e.name === "AbortError") return;
      this.status.textContent = "That file isn't a look saved by this tool.";
    }
  }
}

function modifiedAgainst(params, base) {
  return PARAMS.map(p => p.key).filter(k => k !== "preset" && params[k] !== base[k]);
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export { modifiedKeys };
