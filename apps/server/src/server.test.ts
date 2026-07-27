import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockLatestShotResponse,
  mockMachineStatus,
  mockShotData,
} from "./__fixtures__/api-responses";
import { resetClient } from "./client";
import { setLogLevel } from "./logging";
import { createServer, TOOLS } from "./server";
import { mockServer } from "./test-setup";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * These tests drive the server through a real MCP client over an in-memory
 * transport rather than calling handlers directly, so the request schemas, the
 * result schemas, and the client's own `outputSchema` validation all
 * participate. `listTools()` is called during setup because that is what makes
 * the client cache output-schema validators — without it, `callTool` would not
 * check `structuredContent` against what we advertise.
 */
let client: Client;
let close: () => Promise<void>;

async function connect(): Promise<void> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  await client.listTools();
  close = async () => {
    await client.close();
    await server.close();
  };
}

/**
 * `Client.callTool` and `Client.readResource` return unions that include shapes
 * this server never produces (the legacy `toolResult` arm, binary resource
 * contents). These narrow once so the assertions below stay readable.
 */
interface ToolCallOutcome {
  content?: Array<{ text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function call(
  name: string,
  args?: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const result = await client.callTool({ arguments: args, name });
  return result as ToolCallOutcome;
}

function textOf(result: ToolCallOutcome): string {
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

/** The slice of JSON Schema these assertions poke at. */
interface JsonSchemaNode {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  type?: string;
}

function asNode(schema: unknown): JsonSchemaNode {
  return (schema ?? {}) as JsonSchemaNode;
}

async function toolNamed(name: string) {
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not advertised: ${name}`);
  return tool;
}

function firstContent(result: ReadResourceResult): {
  _meta?: Record<string, unknown>;
  mimeType?: string;
  text?: string;
} {
  return result.contents[0] as {
    _meta?: Record<string, unknown>;
    mimeType?: string;
    text?: string;
  };
}

beforeEach(async () => {
  resetClient({ initialDelayMs: 1 });
  mockServer.use(
    http.get("http://gaggiuino.local/api/system/status", () =>
      HttpResponse.json([mockMachineStatus]),
    ),
    http.get("http://gaggiuino.local/api/shots/latest", () =>
      HttpResponse.json([mockLatestShotResponse]),
    ),
    http.get("http://gaggiuino.local/api/shots/1706547890", () =>
      HttpResponse.json([mockShotData]),
    ),
  );
  await connect();
});

afterEach(async () => {
  await close();
});

describe("tool call logging", () => {
  /**
   * Tool failures come back as `isError` results, which is right for the model
   * but used to leave the operator with nothing: a tool could fail every call
   * and the logs would not show it. These capture the real sink, so the default
   * `console.error` path is in the loop rather than an injected stub.
   */
  function captureLogs() {
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
    });
    setLogLevel("info");
    return {
      records,
      restore: () => {
        spy.mockRestore();
        setLogLevel("silent");
      },
    };
  }

  it("logs a successful call with its name, duration and outcome", async () => {
    const { records, restore } = captureLogs();
    try {
      await call("get_status");
    } finally {
      restore();
    }
    const entry = records.find((record) => record.event === "tool.call");
    expect(entry).toMatchObject({ outcome: "ok", tool: "get_status" });
    expect(typeof entry?.durationMs).toBe("number");
  });

  it("logs a failed call with the reason the model was given", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.error(),
      ),
    );
    const { records, restore } = captureLogs();
    try {
      await call("get_status");
    } finally {
      restore();
    }
    const entry = records.find((record) => record.event === "tool.call");
    expect(entry).toMatchObject({ outcome: "error", tool: "get_status" });
    // The server writes these to be actionable; a bare "error" would throw
    // away the one useful part.
    expect(String(entry?.reason)).toContain("gaggiuino.local");
  });

  it("logs an invalid-argument call as an error outcome", async () => {
    const { records, restore } = captureLogs();
    try {
      await call("get_shot_data", {});
    } finally {
      restore();
    }
    expect(
      records.find((record) => record.event === "tool.call"),
    ).toMatchObject({ outcome: "error", tool: "get_shot_data" });
  });
});

describe("initialize", () => {
  it("advertises the released version, not a hardcoded one", async () => {
    // Read back off the client, so this asserts what actually crossed the
    // handshake rather than what the constant says.
    expect(client.getServerVersion()).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });
});

describe("ListTools", () => {
  it("advertises every tool over the protocol", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      TOOLS.map((tool) => tool.name),
    );
  });

  it("gives every tool a title and honest read-only annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnly`).toBe(
        true,
      );
      expect(
        tool.annotations?.destructiveHint,
        `${tool.name} destructive`,
      ).toBe(false);
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotent`).toBe(
        true,
      );
      expect(
        typeof tool.annotations?.openWorldHint,
        `${tool.name} openWorld`,
      ).toBe("boolean");
    }
  });

  it("marks machine reads open-world and bundled-data reads closed-world", async () => {
    const { tools } = await client.listTools();
    const openWorld = new Map(
      tools.map((tool) => [tool.name, tool.annotations?.openWorldHint]),
    );
    expect(openWorld.get("get_status")).toBe(true);
    expect(openWorld.get("get_shot_data")).toBe(true);
    expect(openWorld.get("list_profiles")).toBe(false);
    expect(openWorld.get("get_dial_in_guidance")).toBe(false);
  });

  it("derives input schemas from the zod schemas the dispatcher enforces", async () => {
    const shotTool = await toolNamed("get_shot_data");
    expect(shotTool.inputSchema.type).toBe("object");
    expect(shotTool.inputSchema.required).toEqual(["shot_id"]);
    // The field description steers a cold model to the id source.
    const properties = asNode(shotTool.inputSchema).properties ?? {};
    expect(properties.shot_id?.description).toContain("get_latest_shot_id");
  });

  it("advertises an object output schema on the data tools", async () => {
    const { tools } = await client.listTools();
    const withOutput = tools
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name);
    expect(withOutput).toEqual([
      "get_status",
      "get_latest_shot_id",
      "get_shot_data",
      "list_profiles",
      "get_profile_info",
    ]);
    for (const tool of tools) {
      if (tool.outputSchema) expect(tool.outputSchema.type).toBe("object");
    }
  });

  it("describes the unit of every numeric field in the shot summary schema", async () => {
    const shotTool = await toolNamed("get_shot_data");
    const metrics = asNode(
      asNode(shotTool.outputSchema).properties?.outcomeMetrics,
    );
    const fields = metrics.properties ?? {};
    expect(Object.keys(fields).length).toBeGreaterThan(0);
    for (const [field, schema] of Object.entries(fields)) {
      expect(schema.description, `${field} description`).toBeTruthy();
    }
    expect(fields.peakPressureBar?.description).toContain("bar");
    expect(fields.totalDurationSec?.description).toContain("seconds");
  });

  it("keeps the shot-graph app wiring on the tools that render it", async () => {
    const { tools } = await client.listTools();
    const graphTool = tools.find((tool) => tool.name === "view_shot_graph");
    expect(graphTool?._meta).toEqual({
      ui: { resourceUri: "ui://shot-graph/app.html" },
    });
    const jsonTool = tools.find((tool) => tool.name === "get_shot_raw_json");
    expect(jsonTool?._meta).toStrictEqual({
      ui: { resourceUri: "ui://shot-graph/app.html", visibility: ["app"] },
    });
  });
});

describe("CallTool", () => {
  it("returns text and schema-valid structured content together", async () => {
    const result = await call("get_status");
    expect(textOf(result)).toContain("Gaggiuino Machine Status");
    expect(result.structuredContent).toMatchObject({ temperatureC: 91 });
    expect(result.isError).toBeFalsy();
  });

  it("validates the shot summary against the advertised output schema", async () => {
    const result = await call("get_shot_data", { shot_id: "1706547890" });
    expect(result.structuredContent).toMatchObject({
      outcomeMetrics: { shotId: "1706547890" },
    });
  });

  it("returns an isError result for invalid arguments", async () => {
    const result = await call("get_shot_data", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("shot_id");
  });

  it("returns an isError result when the machine cannot be reached", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.error(),
      ),
    );
    const result = await call("get_status");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not reach the Gaggiuino machine");
  });

  it("returns an isError result for a shot that does not exist", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/shots/404404", () =>
        HttpResponse.json({ error: "no" }, { status: 404 }),
      ),
    );
    const result = await call("get_shot_data", { shot_id: "404404" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No shot with id '404404'");
  });

  it("returns an isError result for a malformed upstream payload", async () => {
    mockServer.use(
      http.get("http://gaggiuino.local/api/shots/1706547890", () =>
        HttpResponse.json([]),
      ),
    );
    const result = await call("get_shot_data", { shot_id: "1706547890" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("could not understand");
  });

  it("returns an isError result for an unknown tool", async () => {
    const result = await call("no_such_tool");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown tool: no_such_tool");
  });
});

describe("Prompts", () => {
  it("lists the dial-in prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toContain(
      "espresso_shot_analyst",
    );
  });

  it("renders the dial-in prompt with the profile list interpolated", async () => {
    const result = await client.getPrompt({ name: "espresso_shot_analyst" });
    const [message] = result.messages;
    expect(message?.role).toBe("user");
    const text = message?.content.type === "text" ? message.content.text : "";
    expect(text).toContain("Available Profiles");
    expect(text).not.toContain("{profiles_text}");
  });

  it("errors on an unknown prompt", async () => {
    await expect(client.getPrompt({ name: "nope" })).rejects.toThrow(
      "Unknown prompt: nope",
    );
  });
});

describe("Resources", () => {
  it("lists the profile text and the shot-graph app", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      "gaggiuino://profiles",
      "ui://shot-graph/app.html",
    ]);
  });

  it("reads the profile list as plain text", async () => {
    const result = await client.readResource({ uri: "gaggiuino://profiles" });
    expect(firstContent(result).mimeType).toBe("text/plain");
    expect(firstContent(result).text).toContain("Available Profiles");
  });

  it("reads a single profile by uri", async () => {
    const result = await client.readResource({
      uri: "gaggiuino://profiles/zer0",
    });
    expect(firstContent(result).text).toContain("Zer0");
  });

  it("errors on an unknown profile uri", async () => {
    await expect(
      client.readResource({ uri: "gaggiuino://profiles/nope" }),
    ).rejects.toThrow("Profile not found: nope");
  });

  it("reads the shot-graph app html", async () => {
    const result = await client.readResource({
      uri: "ui://shot-graph/app.html",
    });
    const content = firstContent(result);
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("<html");
    expect(content._meta).toEqual({ ui: { prefersBorder: false } });
  });

  it("errors on an unknown resource uri", async () => {
    await expect(
      client.readResource({ uri: "gaggiuino://nope" }),
    ).rejects.toThrow("Unknown resource: gaggiuino://nope");
  });
});
