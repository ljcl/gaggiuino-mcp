import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  describeToolError,
  firstTextBlock,
  MalformedToolResultError,
  readToolJson,
  ServerToolError,
} from "./toolResult";

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ text, type: "text" }], isError };
}

describe("firstTextBlock", () => {
  it("returns the first text block", () => {
    expect(firstTextBlock(textResult("hello"))).toBe("hello");
  });

  it("skips non-text content", () => {
    const result: CallToolResult = {
      content: [
        { data: "", mimeType: "image/png", type: "image" },
        { text: "after the image", type: "text" },
      ],
    };
    expect(firstTextBlock(result)).toBe("after the image");
  });

  it("treats an empty string as no text", () => {
    expect(firstTextBlock(textResult(""))).toBeUndefined();
  });

  it("tolerates a result with no content at all", () => {
    expect(firstTextBlock({ content: [] })).toBeUndefined();
  });
});

describe("readToolJson", () => {
  it("parses the JSON payload", () => {
    expect(readToolJson(textResult('{"id":"42"}'), "get_shot")).toEqual({
      id: "42",
    });
  });

  it("surfaces the server's own message for an isError result", () => {
    const machineOff =
      "Could not reach the Gaggiuino machine at http://gaggiuino.local.";
    expect(() =>
      readToolJson(textResult(machineOff, true), "get_shot"),
    ).toThrow(new ServerToolError(machineOff));
  });

  it("still errors when the server flags an error with no text", () => {
    expect(() =>
      readToolJson({ content: [], isError: true }, "get_shot"),
    ).toThrowError(ServerToolError);
  });

  it("names the tool when the payload is not JSON", () => {
    expect(() => readToolJson(textResult("not json"), "get_shot")).toThrowError(
      MalformedToolResultError,
    );
    expect(() => readToolJson(textResult("not json"), "get_shot")).toThrow(
      /get_shot/,
    );
  });

  it("rejects a successful result with no content", () => {
    expect(() => readToolJson({ content: [] }, "get_shot")).toThrowError(
      MalformedToolResultError,
    );
  });
});

describe("describeToolError", () => {
  it("passes a server message through unchanged", () => {
    expect(describeToolError(new ServerToolError("machine is off"))).toBe(
      "machine is off",
    );
  });

  it("describes a malformed payload", () => {
    expect(
      describeToolError(new MalformedToolResultError("get_shot", "bad")),
    ).toContain("get_shot");
  });

  it("falls back to the message of any other error", () => {
    expect(describeToolError(new Error("socket closed"))).toBe("socket closed");
  });

  it("stringifies non-errors", () => {
    expect(describeToolError("plain string")).toBe("plain string");
  });
});
