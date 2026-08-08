import { describe, expect, it } from "vitest";
import {
  CVD_TYPES,
  compositeOver,
  contrastRatio,
  cvdSeparation,
  deltaE2000,
  deltaE2000Lab,
  type Lab,
  parseColor,
  type Rgb,
  simulateCvd,
  toLab,
} from "./color";

/**
 * The chart palette's accessibility contract is *measured* by the Shot
 * Graph/Chart accessibility story rather than asserted in a comment — but the
 * story only ever asks "is this number past the threshold?", so it cannot tell
 * a correct 20 from a buggy 20. These assertions check the ruler itself.
 */

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

describe("parseColor", () => {
  it("reads six-digit hex", () => {
    expect(parseColor("#2f6fed")).toEqual({ alpha: 1, rgb: [47, 111, 237] });
  });

  it("expands three-digit hex by doubling each nibble", () => {
    expect(parseColor("#f0a")).toEqual({ alpha: 1, rgb: [255, 0, 170] });
  });

  it("reads the alpha channel from four- and eight-digit hex", () => {
    expect(parseColor("#ffffff80")?.alpha).toBeCloseTo(128 / 255, 6);
    expect(parseColor("#fff8")?.alpha).toBeCloseTo(136 / 255, 6);
  });

  it("reads rgb() and rgba(), including the slash-separated form", () => {
    expect(parseColor("rgb(47, 111, 237)")).toEqual({
      alpha: 1,
      rgb: [47, 111, 237],
    });
    expect(parseColor("rgba(47, 111, 237, 0.5)")).toEqual({
      alpha: 0.5,
      rgb: [47, 111, 237],
    });
    expect(parseColor("rgb(47 111 237 / 0.25)")).toEqual({
      alpha: 0.25,
      rgb: [47, 111, 237],
    });
  });

  it("tolerates surrounding whitespace, as getComputedStyle can return", () => {
    expect(parseColor("  #2f6fed  ")?.rgb).toEqual([47, 111, 237]);
  });

  it("returns null for anything it cannot read", () => {
    // A null here means the gate skips a stroke rather than mismeasuring it,
    // so the distinction between "unparseable" and "black" is load-bearing.
    for (const input of ["", "transparent", "#12345", "rgb(1, 2)", "nope"]) {
      expect(parseColor(input)).toBeNull();
    }
  });
});

describe("contrastRatio", () => {
  it("gives exactly 21:1 for black on white", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
  });

  it("gives exactly 1:1 for a color against itself", () => {
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
  });

  it("matches the canonical AA boundary grey", () => {
    // #767676 on white is the textbook 4.5:1 example — the lightest grey that
    // still passes AA for body text.
    expect(contrastRatio([118, 118, 118], WHITE)).toBeCloseTo(4.54, 2);
  });

  it("is symmetric in its arguments", () => {
    const a: Rgb = [47, 111, 237];
    expect(contrastRatio(a, WHITE)).toBeCloseTo(contrastRatio(WHITE, a), 12);
  });
});

describe("compositeOver", () => {
  it("returns the foreground at alpha 1 and the backdrop at alpha 0", () => {
    expect(compositeOver([255, 0, 0], 1, WHITE)).toEqual([255, 0, 0]);
    expect(compositeOver([255, 0, 0], 0, WHITE)).toEqual(WHITE);
  });

  it("blends halfway at alpha 0.5", () => {
    expect(compositeOver(BLACK, 0.5, WHITE)).toEqual([128, 128, 128]);
  });

  it("is what makes a translucent stroke measurable at all", () => {
    // The comparison overlay's contrast claim depends on this: the stroke that
    // reaches the eye is the composite, not the declared color.
    const flattened = compositeOver([47, 111, 237], 0.6, WHITE);
    expect(contrastRatio(flattened, WHITE)).toBeLessThan(
      contrastRatio([47, 111, 237], WHITE),
    );
  });
});

describe("toLab", () => {
  it("puts white at L=100 on the neutral axis", () => {
    const [l, a, b] = toLab(WHITE);
    expect(l).toBeCloseTo(100, 1);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("puts black at L=0", () => {
    expect(toLab(BLACK)[0]).toBeCloseTo(0, 4);
  });

  it("keeps greys on the neutral axis", () => {
    const [, a, b] = toLab([128, 128, 128]);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("places sRGB primaries where CIELAB says they are", () => {
    const [lr, ar, br] = toLab([255, 0, 0]);
    expect(lr).toBeCloseTo(53.24, 0);
    expect(ar).toBeCloseTo(80.09, 0);
    expect(br).toBeCloseTo(67.2, 0);
  });
});

/**
 * Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula:
 * implementation notes, supplementary test data, and mathematical
 * observations" — the standard conformance set. It exists because the formula
 * has branches that are easy to get wrong, and the pairs are chosen to sit
 * exactly on them.
 */
const SHARMA: ReadonlyArray<{
  name: string;
  a: Lab;
  b: Lab;
  expected: number;
}> = [
  // The G-factor cases: near-neutral blues where the a* rescaling dominates.
  {
    a: [50, 2.6772, -79.7751],
    b: [50, 0, -82.7485],
    expected: 2.0425,
    name: "G factor 1",
  },
  {
    a: [50, 3.1571, -77.2803],
    b: [50, 0, -82.7485],
    expected: 2.8615,
    name: "G factor 2",
  },
  {
    a: [50, 2.8361, -74.02],
    b: [50, 0, -82.7485],
    expected: 3.4412,
    name: "G factor 3",
  },
  {
    a: [50, -1.3802, -84.2814],
    b: [50, 0, -82.7485],
    expected: 1.0,
    name: "G factor 4",
  },
  {
    a: [50, -1.1848, -84.8006],
    b: [50, 0, -82.7485],
    expected: 1.0,
    name: "G factor 5",
  },
  {
    a: [50, -0.9009, -85.5211],
    b: [50, 0, -82.7485],
    expected: 1.0,
    name: "G factor 6",
  },

  // Mean-hue wraparound: b* flips sign by a thousandth and the branch that
  // averages the two hues has to cross 0°/360° correctly. A naive mean gives
  // a wildly different answer for pairs that differ this little.
  {
    a: [50, 2.49, -0.001],
    b: [50, -2.49, 0.0009],
    expected: 7.1792,
    name: "hue wrap 1",
  },
  {
    a: [50, 2.49, -0.001],
    b: [50, -2.49, 0.001],
    expected: 7.1792,
    name: "hue wrap 2",
  },
  {
    a: [50, 2.49, -0.001],
    b: [50, -2.49, 0.0011],
    expected: 7.2195,
    name: "hue wrap 3",
  },
  {
    a: [50, 2.49, -0.001],
    b: [50, -2.49, 0.0012],
    expected: 7.2195,
    name: "hue wrap 4",
  },
  {
    a: [50, -0.001, 2.49],
    b: [50, 0.0009, -2.49],
    expected: 4.8045,
    name: "hue wrap 5",
  },
  {
    a: [50, -0.001, 2.49],
    b: [50, 0.001, -2.49],
    expected: 4.8045,
    name: "hue wrap 6",
  },
  {
    a: [50, -0.001, 2.49],
    b: [50, 0.0011, -2.49],
    expected: 4.7461,
    name: "hue wrap 7",
  },
  { a: [50, 2.5, 0], b: [50, 0, -2.5], expected: 4.3065, name: "quarter turn" },

  // Real-surface pairs, including the one whose mean hue lands near 275° —
  // the peak of the rT rotation term.
  {
    a: [60.2574, -34.0099, 36.2677],
    b: [60.4626, -34.1751, 39.4387],
    expected: 1.2644,
    name: "green",
  },
  {
    a: [63.0109, -31.0961, -5.8663],
    b: [62.8187, -29.7946, -4.0864],
    expected: 1.263,
    name: "teal",
  },
  {
    a: [61.2901, 3.7196, -5.3901],
    b: [61.4292, 2.248, -4.962],
    expected: 1.8731,
    name: "near grey",
  },
  {
    a: [35.0831, -44.1164, 3.7933],
    b: [35.0232, -40.0716, 1.5901],
    expected: 1.8645,
    name: "deep green",
  },
  {
    a: [22.7233, 20.0904, -46.694],
    b: [23.0331, 14.973, -42.5619],
    expected: 2.0373,
    name: "rT peak",
  },
  {
    a: [36.4612, 47.858, 18.3852],
    b: [36.2715, 50.5065, 21.2231],
    expected: 1.4146,
    name: "red",
  },
  {
    a: [90.8027, -2.0831, 1.441],
    b: [91.1528, -1.6435, 0.0447],
    expected: 1.4441,
    name: "light 1",
  },
  {
    a: [90.9257, -0.5406, -0.9208],
    b: [88.6381, -0.8985, -0.7239],
    expected: 1.5381,
    name: "light 2",
  },
  {
    a: [6.7747, -0.2908, -2.4247],
    b: [5.8714, -0.0985, -2.2286],
    expected: 0.6377,
    name: "dark 1",
  },
  {
    a: [2.0776, 0.0795, -1.135],
    b: [0.9033, -0.0636, -0.5514],
    expected: 0.9082,
    name: "dark 2",
  },
];

describe("deltaE2000Lab", () => {
  it.each(SHARMA)(
    "matches the reference value: $name",
    ({ a, b, expected }) => {
      expect(deltaE2000Lab(a, b)).toBeCloseTo(expected, 4);
    },
  );

  it("is symmetric in its arguments", () => {
    for (const { a, b } of SHARMA) {
      expect(deltaE2000Lab(a, b)).toBeCloseTo(deltaE2000Lab(b, a), 10);
    }
  });

  it("is zero for a color against itself", () => {
    expect(deltaE2000Lab([50, 2.5, -1.2], [50, 2.5, -1.2])).toBeCloseTo(0, 12);
  });
});

describe("deltaE2000", () => {
  it("is zero for a color against itself", () => {
    expect(deltaE2000([47, 111, 237], [47, 111, 237])).toBeCloseTo(0, 12);
  });

  it("spans the gamut: black to white is a very large difference", () => {
    expect(deltaE2000(BLACK, WHITE)).toBeGreaterThan(95);
  });
});

describe("simulateCvd", () => {
  it("leaves greys untouched under both simulations", () => {
    // A dichromat still sees lightness. This catches a row whose coefficients
    // no longer sum to 1 — but NOT a transposed row, because permuting a row
    // leaves its sum intact and a grey has r = g = b. That case is what the
    // primary mapping below is for.
    for (const type of CVD_TYPES) {
      for (const grey of [BLACK, [128, 128, 128], WHITE] as Rgb[]) {
        const [r, g, b] = simulateCvd(grey, type);
        expect(Math.abs(r - grey[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(g - grey[1])).toBeLessThanOrEqual(1);
        expect(Math.abs(b - grey[2])).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * Where each sRGB primary lands. Six triples pin the effect of all eighteen
   * coefficients in their correct positions, which is the only cheap way to
   * catch the failure #81 names by name: a transposed row still produces
   * plausible-looking colours, so neither the swatch table nor a
   * grey-invariance check notices it.
   */
  const PRIMARY_MAPPING: ReadonlyArray<
    readonly [(typeof CVD_TYPES)[number], Rgb, Rgb]
  > = [
    ["protan", [255, 0, 0], [109, 95, 0]],
    ["protan", [0, 255, 0], [255, 229, 0]],
    ["protan", [0, 0, 255], [0, 89, 255]],
    ["deutan", [255, 0, 0], [163, 144, 0]],
    ["deutan", [0, 255, 0], [239, 214, 58]],
    ["deutan", [0, 0, 255], [0, 61, 251]],
  ];

  it.each(PRIMARY_MAPPING)("maps %s primaries: %j", (type, input, expected) => {
    expect(simulateCvd(input, type)).toEqual(expected);
  });

  it("is a projection: simulating an already-simulated colour is a no-op", () => {
    // The principled version of the claim above. A severity-1.0 simulation
    // maps onto the surface the dichromat can see, so a colour already on that
    // surface must come back unchanged. Deviations here are gamut clamping,
    // which is why the tolerance is in ΔE00 rather than exact channels.
    const samples: Rgb[] = [
      [47, 111, 237],
      [217, 119, 6],
      [190, 70, 70],
      [80, 160, 90],
      [150, 100, 180],
    ];
    for (const type of CVD_TYPES) {
      for (const sample of samples) {
        const once = simulateCvd(sample, type);
        expect(deltaE2000(once, simulateCvd(once, type))).toBeLessThan(5);
      }
    }
  });

  it("pulls red and green toward each other", () => {
    // The defining symptom of both simulated types.
    const red: Rgb = [220, 50, 47];
    const green: Rgb = [56, 142, 60];
    for (const type of CVD_TYPES) {
      expect(
        deltaE2000(simulateCvd(red, type), simulateCvd(green, type)),
      ).toBeLessThan(deltaE2000(red, green));
    }
  });

  it("stays inside the sRGB gamut", () => {
    for (const type of CVD_TYPES) {
      for (const channel of simulateCvd([255, 0, 255], type)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe("cvdSeparation", () => {
  it("never exceeds either per-type difference", () => {
    // It is the minimum across the gated types by definition: a pair counts as
    // separable only if it survives every simulation, not the friendliest one.
    const a: Rgb = [47, 111, 237];
    const b: Rgb = [217, 119, 6];
    const perType = CVD_TYPES.map((type) =>
      deltaE2000(simulateCvd(a, type), simulateCvd(b, type)),
    );
    expect(cvdSeparation(a, b)).toBeCloseTo(Math.min(...perType), 12);
    expect(cvdSeparation(a, b)).toBeLessThanOrEqual(Math.max(...perType));
  });

  it("still calls the pre-#79 green/ochre pair confusable", () => {
    // The historical pin. This is the pair the current palette replaced: it
    // measures a few ΔE00 apart once simulated, far under the 17 the gate
    // requires. If a refactor ever makes this look separable, the maths is
    // wrong — and the gate would be passing a palette it should reject.
    expect(cvdSeparation([44, 160, 44], [181, 131, 42])).toBeLessThan(10);
  });

  it("is zero for a color against itself", () => {
    expect(cvdSeparation([47, 111, 237], [47, 111, 237])).toBeCloseTo(0, 12);
  });
});
