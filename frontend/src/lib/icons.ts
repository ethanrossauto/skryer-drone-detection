// Map marker icons, drawn to canvas and registered with MapLibre as images.
//
// Why canvas instead of static PNG/SVG files: the console only needs a few glyphs
// (a top-down quadcopter for contacts, a microphone for the sensor nodes) in a
// handful of fixed colours, so we render them once at load with a dark halo for
// legibility over the bright satellite basemap. Each is registered at pixelRatio 2
// so it stays crisp on retina displays.

import type maplibregl from "maplibre-gl";

const HALO = "#0b0e14"; // matches the console background — reads as an outline on satellite
const NODE_COLOR = "#4cd5ff"; // cyan — sensor nodes / mics
const RENDER = 64; // logical canvas px; displayed at RENDER / RATIO on the map
const RATIO = 2;

type Draw = (ctx: CanvasRenderingContext2D, s: number, color: string) => void;

/** Top-down quadcopter: four rotor rings on an X frame with a body hub. */
const drawDrone: Draw = (ctx, s, color) => {
  const c = s / 2;
  const d = s * 0.26; // rotor offset from centre
  const rr = s * 0.13; // rotor ring radius
  const rotors: Array<[number, number]> = [
    [c - d, c - d],
    [c + d, c - d],
    [c - d, c + d],
    [c + d, c + d],
  ];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let pass = 0; pass < 2; pass++) {
    const halo = pass === 0;
    ctx.strokeStyle = halo ? HALO : color;
    ctx.fillStyle = halo ? HALO : color;
    ctx.lineWidth = halo ? s * 0.14 : s * 0.06;

    // arms (X frame)
    ctx.beginPath();
    for (const [x, y] of rotors) {
      ctx.moveTo(c, c);
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    // rotor rings
    for (const [x, y] of rotors) {
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // body hub
    ctx.beginPath();
    ctx.arc(c, c, s * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }
};

/** Studio-style microphone: capsule head, cradle arc, stand, base. */
const drawMic: Draw = (ctx, s, color) => {
  const cx = s / 2;
  const headTop = s * 0.16;
  const headW = s * 0.24;
  const headH = s * 0.38;
  const cradleCy = headTop + headH * 0.55;
  const cradleR = s * 0.24;
  const baseY = s * 0.88;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let pass = 0; pass < 2; pass++) {
    const halo = pass === 0;
    ctx.strokeStyle = halo ? HALO : color;
    ctx.fillStyle = halo ? HALO : color;
    ctx.lineWidth = halo ? s * 0.16 : s * 0.07;

    // capsule head — outlined by the halo pass, filled by the colour pass
    ctx.beginPath();
    ctx.roundRect(cx - headW / 2, headTop, headW, headH, headW / 2);
    if (halo) ctx.stroke();
    else ctx.fill();

    // cradle arc
    ctx.beginPath();
    ctx.arc(cx, cradleCy, cradleR, 0.12 * Math.PI, 0.88 * Math.PI);
    ctx.stroke();

    // stand
    ctx.beginPath();
    ctx.moveTo(cx, cradleCy + cradleR);
    ctx.lineTo(cx, baseY);
    ctx.stroke();

    // base
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.16, baseY);
    ctx.lineTo(cx + s * 0.16, baseY);
    ctx.stroke();
  }
};

/** Sensor-array housing with four mic dots — the node "at rest" (fans into 4 mics on hover). */
const drawArray: Draw = (ctx, s, color) => {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const w = s * 0.6; // housing side
  const o = (s - w) / 2;
  const r = s * 0.14; // corner radius
  const c = s / 2;
  const d = s * 0.13; // mic-dot offset from centre
  const dots: Array<[number, number]> = [
    [c - d, c - d],
    [c + d, c - d],
    [c - d, c + d],
    [c + d, c + d],
  ];

  for (let pass = 0; pass < 2; pass++) {
    const halo = pass === 0;
    ctx.strokeStyle = halo ? HALO : color;
    ctx.fillStyle = halo ? HALO : color;
    ctx.lineWidth = halo ? s * 0.16 : s * 0.07;

    // housing — outlined both passes (dark halo then colour)
    ctx.beginPath();
    ctx.roundRect(o, o, w, w, r);
    ctx.stroke();

    // four mic dots, each haloed (dark slightly larger, then colour)
    for (const [x, y] of dots) {
      ctx.beginPath();
      ctx.arc(x, y, halo ? s * 0.11 : s * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

// MapLibre's most universally-accepted image form is a plain
// { width, height, data: Uint8Array } object (the StyleImageInterface). Passing a
// raw ImageData (whose data is a Uint8ClampedArray) is flakier across versions.
/** Mast-mounted PTZ camera — bullet body + lens on a stem/base. The vision layer. */
const drawCamera: Draw = (ctx, s, color) => {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const c = s / 2;
  const bw = s * 0.42; // body width
  const bh = s * 0.18; // body height
  const bx = c - bw / 2;
  const by = s * 0.3;
  const br = s * 0.05;
  const lensX = bx + bw;
  const lensY = by + bh / 2;

  for (let pass = 0; pass < 2; pass++) {
    const halo = pass === 0;
    ctx.strokeStyle = halo ? HALO : color;
    ctx.fillStyle = halo ? HALO : color;
    ctx.lineWidth = halo ? s * 0.16 : s * 0.07;

    // mast stem + base
    ctx.beginPath();
    ctx.moveTo(c, by + bh);
    ctx.lineTo(c, s * 0.82);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - s * 0.16, s * 0.82);
    ctx.lineTo(c + s * 0.16, s * 0.82);
    ctx.stroke();

    // camera body — outlined by halo pass, filled by colour pass
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, br);
    if (halo) ctx.stroke();
    else ctx.fill();

    // lens at the front
    ctx.beginPath();
    ctx.arc(lensX, lensY, s * 0.075, 0, Math.PI * 2);
    if (halo) ctx.stroke();
    else ctx.fill();
  }
};

/** Protected critical-infrastructure site — a transmission/substation pylon over a
 *  ground line. The "asset" the array defends (drones ingress toward it). */
const drawAsset: Draw = (ctx, s, color) => {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const c = s / 2;
  const top = s * 0.2;
  const bot = s * 0.74;
  const halfTop = s * 0.1; // pylon half-width at the top
  const halfBot = s * 0.22; // pylon half-width at the base

  for (let pass = 0; pass < 2; pass++) {
    const halo = pass === 0;
    ctx.strokeStyle = halo ? HALO : color;
    ctx.fillStyle = halo ? HALO : color;
    ctx.lineWidth = halo ? s * 0.15 : s * 0.06;

    // two splayed legs (trapezoid silhouette)
    ctx.beginPath();
    ctx.moveTo(c - halfBot, bot);
    ctx.lineTo(c - halfTop, top);
    ctx.moveTo(c + halfBot, bot);
    ctx.lineTo(c + halfTop, top);
    ctx.stroke();

    // crossbars (upper + lower)
    for (const yf of [0.36, 0.56]) {
      const y = top + (bot - top) * yf;
      const half = halfTop + (halfBot - halfTop) * yf;
      ctx.beginPath();
      ctx.moveTo(c - half, y);
      ctx.lineTo(c + half, y);
      ctx.stroke();
    }

    // mast cap + ground line
    ctx.beginPath();
    ctx.moveTo(c - halfTop, top);
    ctx.lineTo(c + halfTop, top);
    ctx.moveTo(c - s * 0.3, bot);
    ctx.lineTo(c + s * 0.3, bot);
    ctx.stroke();
  }
};

function render(draw: Draw, color: string): { width: number; height: number; data: Uint8Array } {
  const px = RENDER * RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(RATIO, RATIO);
  draw(ctx, RENDER, color);
  const { data } = ctx.getImageData(0, 0, px, px);
  return { width: px, height: px, data: new Uint8Array(data.buffer) };
}

/** Image ids registered on the map (referenced by the symbol layers' icon-image). */
export const ICONS = {
  droneConfirmed: "skryer-drone-confirmed",
  droneUnknown: "skryer-drone-unknown",
  mic: "skryer-mic",
  array: "skryer-array",
  camera: "skryer-camera",
  asset: "skryer-asset",
} as const;

// The PTZ camera / slew-line colour — a distinct green for the vision (EO) layer.
export const CAMERA_COLOR = "#3ee6a0";

// The protected asset — neutral cool white so it stands out from the amber cues / red
// drones / cyan nodes / green camera as "the thing being defended".
export const ASSET_COLOR = "#dfe9f5";

// One place that maps each icon id to how it's drawn + its colour, so the map images
// and the HTML legend swatches always render the exact same glyph.
const REGISTRY: Record<string, { draw: Draw; color: string }> = {
  [ICONS.droneConfirmed]: { draw: drawDrone, color: "#3ee6a0" }, // green — visual ID, confirmed
  [ICONS.droneUnknown]: { draw: drawDrone, color: "#ff4d4d" }, // red — triangulated, range lock (not yet ID'd)
  [ICONS.mic]: { draw: drawMic, color: NODE_COLOR },
  [ICONS.array]: { draw: drawArray, color: NODE_COLOR },
  [ICONS.camera]: { draw: drawCamera, color: CAMERA_COLOR },
  [ICONS.asset]: { draw: drawAsset, color: ASSET_COLOR },
};

/** Register every console icon on the map. Safe to call once after style load. */
export function addIcons(map: maplibregl.Map): void {
  for (const [id, { draw, color }] of Object.entries(REGISTRY)) {
    if (map.hasImage(id)) continue;
    map.addImage(id, render(draw, color), { pixelRatio: RATIO });
  }
}

/** PNG data URL of an icon, for HTML legend swatches (same glyph as the map). */
export function iconDataUrl(id: keyof typeof ICONS | string): string {
  const entry = REGISTRY[id];
  if (!entry) return "";
  const px = RENDER * RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(RATIO, RATIO);
  entry.draw(ctx, RENDER, entry.color);
  return canvas.toDataURL();
}
