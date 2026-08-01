/**
 * Color maths for the accessibility gates.
 *
 * These exist so the palette's two accessibility claims — "clears 3:1 against
 * the background" and "still separable to a deutan/protan viewer" — are
 * *measured* rather than asserted in a comment. The stories that consume them
 * read colors the browser has already resolved, so what gets checked is what
 * ships, including any host override applied on top of the tokens.
 *
 * No dependencies: an MCP app is a single inlined HTML file, and a color
 * library would be paid for on every render.
 */

/** An opaque sRGB color, 0-255 per channel. */
export type Rgb = readonly [number, number, number];

/** Parse `#rgb`, `#rrggbb`, `rgb(…)` or `rgba(…)` into channels plus alpha. */
export function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const text = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(
    text,
  );
  const body = hex?.[1];
  if (body) {
    const short = body.length <= 4;
    const size = short ? 1 : 2;
    const channel = (i: number) => {
      const part = body.slice(i * size, i * size + size);
      return Number.parseInt(short ? part + part : part, 16);
    };
    const hasAlpha = body.length === 4 || body.length === 8;
    return {
      alpha: hasAlpha ? channel(3) / 255 : 1,
      rgb: [channel(0), channel(1), channel(2)],
    };
  }

  const body2 = /^rgba?\(([^)]+)\)$/i.exec(text)?.[1];
  if (body2) {
    const parts = body2
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) return null;
    if (parts.some(Number.isNaN)) return null;
    return { alpha: a ?? 1, rgb: [r, g, b] };
  }

  return null;
}

/** Per-channel sRGB companding, kept explicit so channels stay a fixed triple. */
function mapChannels(
  c: Rgb,
  f: (v: number) => number,
): [number, number, number] {
  return [f(c[0]), f(c[1]), f(c[2])];
}

function toLinear(c: Rgb): [number, number, number] {
  return mapChannels(c, (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}

function fromLinear(l: readonly [number, number, number]): Rgb {
  return mapChannels(l, (v) => {
    const c = Math.min(1, Math.max(0, v));
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  });
}

function relativeLuminance(c: Rgb): number {
  const [r, g, b] = toLinear(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a translucent color over an opaque backdrop. */
export function compositeOver(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const blend = (f: number, b: number) =>
    Math.round(f * alpha + b * (1 - alpha));
  return [blend(fg[0], bg[0]), blend(fg[1], bg[1]), blend(fg[2], bg[2])];
}

/**
 * Machado, Oliveira & Fernandes (2009) severity-1.0 transforms, applied in
 * linear RGB. Deuteranopia and protanopia are the two the chart palette is
 * required to survive: together they are ~8% of men. Tritanopia is left out on
 * purpose — it is ~0.01% of people, and every blue/green pairing collapses
 * under it, so gating on it would reject any palette using both.
 */
const CVD_MATRICES: Record<
  "deutan" | "protan",
  readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ]
> = {
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
} as const;

export type CvdType = keyof typeof CVD_MATRICES;

/** The two types the palette is gated on. */
export const CVD_TYPES: readonly CvdType[] = ["protan", "deutan"];

/** How `color` appears to a viewer with `type` dichromacy. */
export function simulateCvd(color: Rgb, type: CvdType): Rgb {
  const [r, g, b] = toLinear(color);
  const [row0, row1, row2] = CVD_MATRICES[type];
  const apply = (row: readonly [number, number, number]) =>
    row[0] * r + row[1] * g + row[2] * b;
  return fromLinear([apply(row0), apply(row1), apply(row2)]);
}

/** A CIELAB color: lightness plus the two opponent axes. */
export type Lab = readonly [number, number, number];

/** sRGB → CIELAB (D65). */
export function toLab(c: Rgb): [number, number, number] {
  const [r, g, b] = toLinear(c);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000 perceptual difference. Roughly: 1 is the just-noticeable
 * difference, and two chart series want to be well clear of that.
 */
export function deltaE2000(c1: Rgb, c2: Rgb): number {
  return deltaE2000Lab(toLab(c1), toLab(c2));
}

/**
 * The CIEDE2000 formula itself, over CIELAB.
 *
 * Split out from the sRGB entry point above so it can be asserted against the
 * Sharma, Wu & Dalal (2005) reference set, which is published as Lab pairs and
 * reaches values no sRGB color can produce. That set exists because this
 * formula is notoriously easy to get subtly wrong — the mean-hue branch below
 * and the `rT` rotation term are the two places it usually happens, and both
 * fail by *inflating* small differences, which would leave the palette gate
 * green while it silently stopped measuring anything.
 */
export function deltaE2000Lab(lab1: Lab, lab2: Lab): number {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;

  const avgL = (l1 + l2) / 2;
  const c1ab = Math.hypot(a1, b1);
  const c2ab = Math.hypot(a2, b2);
  const avgC = (c1ab + c2ab) / 2;
  const g = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + g);
  const a2p = a2 * (1 + g);
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const avgCp = (c1p + c2p) / 2;

  const hue = (ap: number, bp: number) => {
    if (ap === 0 && bp === 0) return 0;
    const t = deg(Math.atan2(bp, ap));
    return t >= 0 ? t : t + 360;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);

  let dhp = h2p - h1p;
  if (c1p * c2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;

  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(rad(dhp) / 2);

  let avgHp: number;
  if (c1p * c2p === 0) avgHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) avgHp = (h1p + h2p) / 2;
  else avgHp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;

  const t =
    1 -
    0.17 * Math.cos(rad(avgHp - 30)) +
    0.24 * Math.cos(rad(2 * avgHp)) +
    0.32 * Math.cos(rad(3 * avgHp + 6)) -
    0.2 * Math.cos(rad(4 * avgHp - 63));
  const sL = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const sC = 1 + 0.045 * avgCp;
  const sH = 1 + 0.015 * avgCp * t;
  const rT =
    -2 *
    Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((avgHp - 275) / 25) ** 2))));

  return Math.sqrt(
    (dLp / sL) ** 2 +
      (dCp / sC) ** 2 +
      (dHp / sH) ** 2 +
      rT * (dCp / sC) * (dHp / sH),
  );
}

/**
 * Worst-case separation between two colors across the gated CVD types. The
 * minimum is the honest number: a pair only counts as distinguishable if it
 * survives *every* simulation, not the friendliest one.
 */
export function cvdSeparation(a: Rgb, b: Rgb): number {
  return Math.min(
    ...CVD_TYPES.map((type) =>
      deltaE2000(simulateCvd(a, type), simulateCvd(b, type)),
    ),
  );
}
