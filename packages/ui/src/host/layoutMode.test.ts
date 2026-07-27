import { describe, expect, it } from "vitest";
import {
  detectMobile,
  type LayoutHostContext,
  MOBILE_BREAKPOINT_PX,
  widthFromHost,
} from "./layoutMode";

const DESKTOP_WIDTH = MOBILE_BREAKPOINT_PX + 200;
const PHONE_WIDTH = 402;

describe("widthFromHost", () => {
  it("reads a fixed width", () => {
    expect(widthFromHost({ height: 800, width: 500 })).toBe(500);
  });

  it("reads a bounded maxWidth", () => {
    expect(widthFromHost({ maxHeight: 800, maxWidth: 420 })).toBe(420);
  });

  it("returns undefined when the host reports no dimensions", () => {
    expect(widthFromHost(undefined)).toBeUndefined();
  });

  it("returns undefined when only height is reported", () => {
    expect(widthFromHost({ height: 800, maxWidth: undefined })).toBeUndefined();
  });
});

describe("detectMobile", () => {
  const desktop: LayoutHostContext = {};

  it("is false when every signal says desktop", () => {
    expect(
      detectMobile(desktop, DESKTOP_WIDTH, "Mozilla/5.0 (Macintosh)"),
    ).toBe(false);
  });

  it("trusts an explicit mobile platform over a wide viewport", () => {
    expect(detectMobile({ platform: "mobile" }, DESKTOP_WIDTH)).toBe(true);
  });

  it("treats touch-without-hover as mobile", () => {
    const host: LayoutHostContext = {
      deviceCapabilities: { hover: false, touch: true },
    };
    expect(detectMobile(host, DESKTOP_WIDTH)).toBe(true);
  });

  it("does not treat a touchscreen laptop as mobile", () => {
    const host: LayoutHostContext = {
      deviceCapabilities: { hover: true, touch: true },
    };
    expect(detectMobile(host, DESKTOP_WIDTH)).toBe(false);
  });

  it("uses a narrow host container even when the iframe is wide", () => {
    const host: LayoutHostContext = { containerDimensions: { width: 380 } };
    expect(detectMobile(host, DESKTOP_WIDTH)).toBe(true);
  });

  it("falls back to the iframe viewport width", () => {
    expect(detectMobile(desktop, PHONE_WIDTH)).toBe(true);
  });

  it("sniffs the host-reported user agent as a last resort", () => {
    const host: LayoutHostContext = { userAgent: "Mozilla/5.0 (iPhone)" };
    expect(detectMobile(host, DESKTOP_WIDTH)).toBe(true);
  });

  it("sniffs the caller's user agent when the host reports none", () => {
    expect(detectMobile(desktop, DESKTOP_WIDTH, "Mozilla/5.0 (Android)")).toBe(
      true,
    );
  });

  it("prefers the host user agent over the caller's", () => {
    const host: LayoutHostContext = { userAgent: "Mozilla/5.0 (Macintosh)" };
    expect(detectMobile(host, DESKTOP_WIDTH, "Mozilla/5.0 (iPhone)")).toBe(
      false,
    );
  });

  it("treats the breakpoint itself as desktop", () => {
    expect(detectMobile(desktop, MOBILE_BREAKPOINT_PX)).toBe(false);
  });
});
