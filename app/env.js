// Capability checks: WebCodecs, File System Access, WebGPU adapter, H.264 encoder support.
import { UserError } from "./errors.js";

export const isChromium = () => !!navigator.userAgentData?.brands?.some(b => /Chromium/.test(b.brand));

export function browserName() {
  const brands = navigator.userAgentData?.brands?.filter(b => !/Not.?A.?Brand/i.test(b.brand)) ?? [];
  const main = brands.find(b => !/Chromium/.test(b.brand)) ?? brands[0];
  if (main) return `${main.brand} ${main.version}`;
  const ff = navigator.userAgent.match(/Firefox\/(\d+)/);
  return ff ? `Firefox ${ff[1]}` : "unknown browser";
}

// Best guess from the WebGPU adapter info. Browsers report little, so this is a heuristic.
export function gpuKind(info) {
  const s = [info?.vendor, info?.architecture, info?.device, info?.description].join(" ").toLowerCase();
  if (!s.trim()) return "unknown";
  if (/nvidia|geforce|rtx|gtx|radeon rx|\brx ?\d{3,4}|arc a\d|alchemist|battlemage/.test(s)) return "discrete";
  if (/intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|vega \d/.test(s)) return "integrated";
  return "unknown";
}

// H.264 High profile: level 5.1 covers 4K up to 30 fps, 5.2 above (spec § Export).
export const h264CodecString = rate => rate > 30.01 ? "avc1.640034" : "avc1.640033";

// Default bitrate: 0.35 bits per pixel per frame.
export const defaultBitrate = (width, height, [num, den]) => Math.round(0.35 * width * height * num / den);

// Picks the codec string and acceleration the encoder accepts, preferring hardware.
export async function pickEncoder({ width, height, fps, bitrate }) {
  const rate = fps[0] / fps[1];
  const codec = h264CodecString(rate);
  if (!("VideoEncoder" in self))
    throw new UserError("This browser has no video encoder (WebCodecs). Open the tool in current Chrome or Edge.");
  for (const accel of ["prefer-hardware", "no-preference"]) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported(
        { codec, width, height, bitrate, framerate: rate, hardwareAcceleration: accel });
      if (supported) return { codec, accel, hardware: accel === "prefer-hardware" };
    } catch { /* try the next option */ }
  }
  throw new UserError(`This browser can't encode H.264 at ${width}×${height}. Update Chrome or Edge, and check that hardware acceleration is on in the browser settings.`);
}

// Runs once on load. `problems` block the tool; `warnings` are shown but don't.
export async function checkEnvironment() {
  const env = {
    browser: browserName(), chromium: isChromium(),
    webcodecs: "VideoDecoder" in self && "VideoEncoder" in self,
    fsa: "showSaveFilePicker" in self,
    webgl2: !!document.createElement("canvas").getContext("webgl2"),
    gpu: null, gpuKind: "unknown", encoder: null,
    problems: [], warnings: [],
  };
  if (location.protocol === "file:")
    env.problems.push("The page was opened from disk. Start it with `python -m http.server` and open it at http://localhost:8000.");
  if (!env.chromium)
    env.problems.push(`This is ${env.browser}. The tool needs Chrome or Edge on Windows: other browsers can't save the export straight to disk or use the hardware encoder.`);
  if (!env.webcodecs) env.problems.push("This browser has no WebCodecs video support. Update Chrome or Edge.");
  if (!env.fsa) env.problems.push("This browser can't save files directly to disk (File System Access). Use Chrome or Edge.");
  if (!env.webgl2) env.problems.push("WebGL2 isn't available, so frames can't be rendered. Turn on hardware acceleration in the browser settings.");

  if (navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      const i = ad?.info;
      if (i) {
        env.gpu = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" · ") || "unnamed adapter";
        env.gpuKind = gpuKind(i);
      }
    } catch { /* reported as missing below */ }
  }
  if (!env.gpu) env.warnings.push("No WebGPU adapter. Person detection will fall back to the much slower CPU path.");
  else if (env.gpuKind === "integrated")
    env.warnings.push("Detection is running on the integrated GPU. In Windows Settings → System → Display → Graphics, set your browser to High performance.");

  if (env.webcodecs) {
    try {
      env.encoder = await pickEncoder({ width: 3840, height: 2160, fps: [24, 1], bitrate: defaultBitrate(3840, 2160, [24, 1]) });
      if (!env.encoder.hardware)
        env.warnings.push("4K H.264 encoding will run in software, so export will be slow. Check that hardware acceleration is on in the browser settings.");
    } catch (e) { env.problems.push(e.message); }
  }
  return env;
}
