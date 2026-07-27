import { type App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it, vi } from "vitest";
import { canDownloadFiles, downloadTextFile, toCsv } from "./download";

/** Minimal stand-in for the parts of `App` the download helpers touch. */
function fakeApp(overrides: Partial<App>): App {
  return overrides as App;
}

describe("canDownloadFiles", () => {
  it("is false without an app", () => {
    expect(canDownloadFiles(null)).toBe(false);
  });

  it("is false when the host does not advertise downloads", () => {
    const app = fakeApp({ getHostCapabilities: () => ({ openLinks: {} }) });
    expect(canDownloadFiles(app)).toBe(false);
  });

  it("is true when the host advertises downloads", () => {
    const app = fakeApp({ getHostCapabilities: () => ({ downloadFile: {} }) });
    expect(canDownloadFiles(app)).toBe(true);
  });
});

describe("downloadTextFile", () => {
  it("sends the text as an embedded resource", async () => {
    const downloadFile = vi.fn().mockResolvedValue({});
    const app = fakeApp({ downloadFile });

    await downloadTextFile(app, {
      filename: "shot-42.csv",
      mimeType: "text/csv",
      text: "time\n0",
    });

    expect(downloadFile).toHaveBeenCalledWith({
      contents: [
        {
          resource: {
            mimeType: "text/csv",
            text: "time\n0",
            uri: "file:///shot-42.csv",
          },
          type: "resource",
        },
      ],
    });
  });

  it("reports success when the host accepts", async () => {
    const app = fakeApp({ downloadFile: vi.fn().mockResolvedValue({}) });
    await expect(
      downloadTextFile(app, {
        filename: "a.csv",
        mimeType: "text/csv",
        text: "",
      }),
    ).resolves.toBe(true);
  });

  it("reports failure when the host declines", async () => {
    const app = fakeApp({
      downloadFile: vi.fn().mockResolvedValue({ isError: true }),
    });
    await expect(
      downloadTextFile(app, {
        filename: "a.csv",
        mimeType: "text/csv",
        text: "",
      }),
    ).resolves.toBe(false);
  });
});

describe("toCsv", () => {
  it("writes a header row followed by the values", () => {
    const rows = [
      { pressure: 9.1, time: 0 },
      { pressure: 8.7, time: 0.1 },
    ];
    expect(toCsv(rows, ["time", "pressure"])).toBe(
      "time,pressure\n0,9.1\n0.1,8.7",
    );
  });

  it("leaves a missing value blank rather than shifting the row", () => {
    const rows = [{ pressure: undefined, time: 1 }];
    expect(toCsv(rows, ["time", "pressure"])).toBe("time,pressure\n1,");
  });

  it("quotes fields containing a delimiter, quote, or newline", () => {
    const rows = [{ note: 'a,b "c"\nd' }];
    expect(toCsv(rows, ["note"])).toBe('note\n"a,b ""c""\nd"');
  });

  it("emits the header alone for no rows", () => {
    expect(toCsv([], ["time"])).toBe("time");
  });
});
