// Minimal in-browser test harness. No framework: tests are async functions that throw on failure.
const registry = [];
let currentGroup = "";

export const group = name => { currentGroup = name; };
export const test = (name, fn, { slow = false } = {}) => registry.push({ group: currentGroup, name, fn, slow });

export class AssertionError extends Error { constructor(m) { super(m); this.name = "AssertionError"; } }
export function assert(cond, msg = "assertion failed") { if (!cond) throw new AssertionError(msg); }
export function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
}
export async function rejects(promise, match, msg = "") {
  try { await promise; } catch (e) {
    if (match && !(match instanceof RegExp ? match.test(e.message) : e.message.includes(match)))
      throw new AssertionError(`${msg ? msg + ": " : ""}rejected with "${e.message}", expected ${match}`);
    return e;
  }
  throw new AssertionError(`${msg ? msg + ": " : ""}expected a rejection`);
}

// Loads a committed fixture as a File, the way the file picker would hand it over.
export async function fixture(name) {
  const r = await fetch(new URL(`./fixtures/${name}`, import.meta.url), { cache: "no-store" });
  if (!r.ok) throw new Error(`fixture ${name}: HTTP ${r.status}`);
  return new File([await r.blob()], name);
}

// A writable file in the origin-private file system: real disk streaming, no save dialog.
export async function opfsFile(name) {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(name, { create: true });
}

export async function run(el, { filter = "", includeSlow = true } = {}) {
  const results = [];
  const list = registry.filter(t => (includeSlow || !t.slow) &&
    `${t.group} ${t.name}`.toLowerCase().includes(filter.toLowerCase()));
  let lastGroup = null;
  for (const t of list) {
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      el.insertAdjacentHTML("beforeend", `<h2>${t.group}</h2>`);
    }
    const row = document.createElement("div");
    row.className = "t run";
    row.textContent = t.name;
    el.append(row);
    const t0 = performance.now();
    let error = null, note = null;
    try { note = await t.fn(); } catch (e) { error = e; console.error(t.name, e); }
    const ms = performance.now() - t0;
    row.className = "t " + (error ? "fail" : "pass");
    row.innerHTML = "";
    row.append(Object.assign(document.createElement("b"), { textContent: error ? "FAIL" : "pass" }),
      ` ${t.name} `, Object.assign(document.createElement("i"), { textContent: `${ms.toFixed(0)} ms` }));
    if (error || note) row.append(Object.assign(document.createElement("pre"),
      { textContent: error ? `${error.name}: ${error.message}` : String(note) }));
    results.push({ group: t.group, name: t.name, pass: !error, ms, error: error?.message, note });
  }
  return results;
}
