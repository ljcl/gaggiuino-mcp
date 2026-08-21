import { readFileSync } from "node:fs";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  mockLatestShotResponse,
  mockMachineStatus,
  mockShotData,
} from "./__fixtures__/api-responses";
import { resetClient } from "./client";
import { loadPrompts } from "./loader";
import { setLogLevel } from "./logging";
import { connectTestClient, type McpTestClient } from "./mcpTestClient";
import { TOOLS } from "./server";
import { mockServer } from "./test-setup";
import {
  normalizeToolContract,
  serializeToolContract,
  TOOL_CONTRACT_PATH,
} from "./toolContract";
import { TOOLS_BY_NAME } from "./tools";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * These tests drive the server over the wire — real `Request`s through the
 * fetch handler in the legacy era — rather than calling handlers directly, so
 * the era codec and everything it serializes participate. The modern era's
 * own assertions live in `modern.test.ts`; the surface-parity tests there are
 * what tie the two eras to one advertised surface.
 */
let client: McpTestClient;
let close: () => Promise<void>;

async function connect(): Promise<void> {
  client = await connectTestClient("test-client");
  close = client.close;
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

function firstContent(result: { contents: unknown[] }): {
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

  it("logs a genuine bug at error level with the stack, and still answers", async () => {
    // Expected failures are results; anything else is a bug, and the model
    // result cannot carry a stack — the log is the only place it survives.
    // No shipped tool throws on demand, so one is planted in the registry
    // `handleToolCall` dispatches from.
    TOOLS_BY_NAME.set("planted_bug", {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description: "test-only",
      handler: () => {
        throw new Error("planted bug");
      },
      inputSchema: z.object({}),
      name: "planted_bug",
      title: "Planted bug",
    });
    const { records, restore } = captureLogs();
    try {
      const result = await call("planted_bug");
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("planted bug");
    } finally {
      restore();
      TOOLS_BY_NAME.delete("planted_bug");
    }
    const entry = records.find((record) => record.event === "tool.error");
    expect(entry).toMatchObject({ reason: "planted bug", tool: "planted_bug" });
    expect(String(entry?.stack)).toContain("planted bug");
  });

  it("survives a bug that throws something that is not an Error", async () => {
    // `throw "string"` has no message and no stack; the log and the result
    // must not crash on the shape of what a broken handler hurled.
    TOOLS_BY_NAME.set("planted_string_bug", {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description: "test-only",
      handler: () => {
        throw "planted string";
      },
      inputSchema: z.object({}),
      name: "planted_string_bug",
      title: "Planted string bug",
    });
    const { records, restore } = captureLogs();
    try {
      const result = await call("planted_string_bug");
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("planted string");
    } finally {
      restore();
      TOOLS_BY_NAME.delete("planted_string_bug");
    }
    expect(
      records.find((record) => record.event === "tool.error"),
    ).toMatchObject({ reason: "planted string" });
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

  /**
   * The tools that change the machine, named here rather than derived from the
   * annotations they are being checked against. A new write tool has to be
   * added to this list deliberately; a read tool that quietly loses
   * `readOnlyHint` fails instead of redefining what the test asserts.
   */
  const WRITE_TOOLS = new Set([
    "delete_profile",
    "select_profile",
    "upload_profile",
  ]);

  /**
   * Writes that are not safe to repeat, named the same way and for the same
   * reason. `POST /api/profile` mints a fresh id on every call, so a retried
   * upload leaves a duplicate profile behind — and `idempotentHint` is the flag
   * a host keys an automatic retry on.
   *
   * `delete_profile` is absent because it declares no `idempotentHint` at all:
   * whether deleting twice is safe depends on whether ids are reused after a
   * delete, which the machine's documentation does not say. See
   * `IDEMPOTENCE_UNSTATED` below — absent and `false` are different claims.
   */
  const NON_IDEMPOTENT_TOOLS = new Set(["upload_profile"]);

  /**
   * Tools that deliberately state no `idempotentHint`, because nobody has
   * established the answer against hardware. Named rather than derived so a
   * tool cannot lose the hint by accident and pass.
   */
  const IDEMPOTENCE_UNSTATED = new Set(["delete_profile"]);

  /**
   * Tools that destroy something. One, and it took a hardware-verified endpoint
   * and an unrecoverable failure mode to earn it — a create is additive and a
   * selection replaces a selection, so neither of the other two writes qualifies.
   * Named rather than derived for the same reason as the sets above: a new tool
   * must claim this deliberately, and a tool that quietly gains it fails here.
   */
  const DESTRUCTIVE_TOOLS = new Set(["delete_profile"]);

  it("gives every tool a title and honest annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnly`).toBe(
        !WRITE_TOOLS.has(tool.name),
      );
      // Only `delete_profile`. Selecting a profile replaces a selection rather
      // than destroying anything, and uploading one is additive — REST offers no
      // verb that overwrites. Deleting one is the exception, and there is no
      // restore path, so the flag is literal rather than cautious.
      expect(
        tool.annotations?.destructiveHint,
        `${tool.name} destructive`,
      ).toBe(DESTRUCTIVE_TOOLS.has(tool.name));
      // Three states, not two: true, false, and deliberately unstated. Absent
      // means nobody has established the answer against hardware, which is a
      // different claim from "this is not idempotent".
      if (IDEMPOTENCE_UNSTATED.has(tool.name)) {
        expect(
          tool.annotations?.idempotentHint,
          `${tool.name} idempotent`,
        ).toBeUndefined();
      } else {
        expect(
          tool.annotations?.idempotentHint,
          `${tool.name} idempotent`,
        ).toBe(!NON_IDEMPOTENT_TOOLS.has(tool.name));
      }
      expect(
        typeof tool.annotations?.openWorldHint,
        `${tool.name} openWorld`,
      ).toBe("boolean");
    }
  });

  it("advertises the machine write as a write", async () => {
    // A write tool arriving without readOnlyHint: false is read by the host as
    // just another read, which is how a machine gets changed with no prompt.
    const tool = await toolNamed("select_profile");
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect(tool.description).toContain("confirm the profile with the user");
  });

  it("advertises the profile upload as a write that must not be repeated", async () => {
    // The pair matters more than either flag alone: readOnlyHint is what gets
    // the user asked, idempotentHint: false is what stops a host retrying a
    // call that may already have created a profile.
    const tool = await toolNamed("upload_profile");
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.idempotentHint).toBe(false);
    expect(tool.description).toContain("get an explicit yes");
  });

  it("marks machine reads open-world and bundled-data reads closed-world", async () => {
    const { tools } = await client.listTools();
    const openWorld = new Map(
      tools.map((tool) => [tool.name, tool.annotations?.openWorldHint]),
    );
    expect(openWorld.get("get_status")).toBe(true);
    expect(openWorld.get("get_shot_data")).toBe(true);
    // list_profiles reads the machine's own inventory now, so closed-world
    // would be a lie even though it can fall back to bundled documentation.
    expect(openWorld.get("list_profiles")).toBe(true);
    expect(openWorld.get("get_machine_settings")).toBe(true);
    expect(openWorld.get("get_maintenance_status")).toBe(true);
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
      "list_recent_shots",
      "get_shot_data",
      "list_profiles",
      "get_profile_info",
      "get_maintenance_status",
      "upload_profile",
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

/**
 * Permission grants are keyed to the advertised tool surface, so a redeploy
 * that changes it drops the grant and puts the user back on a prompt for every
 * call. See `toolContract.ts` for why that is worth a committed artifact.
 */
describe("the advertised contract", () => {
  /**
   * The tools allowed to set `_meta["anthropic/requiresUserInteraction"]`.
   *
   * This was a blanket prohibition — no tool may set it — on the reasoning that
   * the flag defeats "don't ask again" in every mode and *"nothing here warrants
   * it, every tool reads"*. `delete_profile` does not read, and an
   * unsuppressable prompt is the point rather than the cost. The rule became a
   * set rather than being deleted, so the prohibition still holds everywhere
   * else.
   */
  const ALWAYS_PROMPT_TOOLS = new Set(["delete_profile"]);

  it("matches the committed tool contract", async () => {
    // Regenerate with `bun run generate-tool-contract` when the change is
    // intended — and read the diff, because it is the list of grants every
    // existing installation is about to lose.
    const { tools } = await client.listTools();
    const committed: unknown = JSON.parse(
      readFileSync(TOOL_CONTRACT_PATH, "utf-8"),
    );
    expect(committed).toEqual(normalizeToolContract(tools));
  });

  it("keeps the committed contract byte-identical to the generator", async () => {
    // Semantically right but textually different means the file was hand-edited
    // rather than regenerated, which is how a contract stops being a record of
    // anything.
    const { tools } = await client.listTools();
    expect(readFileSync(TOOL_CONTRACT_PATH, "utf-8")).toBe(
      serializeToolContract(tools),
    );
  });

  it("asks only the destructive tool to prompt on every call", async () => {
    // A tool whose `_meta` carries this flag falls through to the permission
    // prompt in every mode, the host offers no "don't ask again", and an
    // existing allow rule does not skip it.
    //
    // That is a cost for a tool that reads and the entire point for one that
    // deletes, so this is a set rather than a prohibition — and the set is
    // written out rather than derived from `destructiveHint`, because a tool
    // picking the flag up silently is exactly the regression worth catching.
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const meta = (tool._meta ?? {}) as Record<string, unknown>;
      expect(
        meta["anthropic/requiresUserInteraction"],
        `${tool.name} requiresUserInteraction`,
      ).toBe(ALWAYS_PROMPT_TOOLS.has(tool.name) ? true : undefined);
    }
  });

  it("promises no list that can change under a host", async () => {
    // `listChanged` is the server telling a host "re-fetch this list when I say
    // so", and a re-fetch is what re-keys the cached tools a grant is stored
    // against. Every list here is a module-level constant, so claiming it would
    // be a lie as well as an invitation to invalidate the user's permissions.
    const capabilities = client.getServerCapabilities() as {
      prompts?: { listChanged?: boolean };
      resources?: { listChanged?: boolean; subscribe?: boolean };
      tools?: { listChanged?: boolean };
    };
    expect(capabilities?.tools?.listChanged).toBeUndefined();
    expect(capabilities?.prompts?.listChanged).toBeUndefined();
    expect(capabilities?.resources?.listChanged).toBeUndefined();
    // Subscriptions are the same bargain for resources, and are equally unclaimed.
    expect(capabilities?.resources?.subscribe).toBeUndefined();
  });

  it("serves the same list on every call", async () => {
    const first = await client.listTools();
    const second = await client.listTools();
    expect(second).toEqual(first);
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
  async function promptText(
    name: string,
    args?: Record<string, string>,
  ): Promise<string> {
    const result = await client.getPrompt({ arguments: args, name });
    const [message] = result.messages;
    expect(message?.role).toBe("user");
    return message?.content.type === "text" ? message.content.text : "";
  }

  it("advertises every prompt with a title and a description", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      "espresso_shot_analyst",
      "dial_in_new_bag",
      "diagnose_last_shot",
      "choose_profile",
    ]);
    for (const prompt of prompts) {
      expect(prompt.title, prompt.name).toBeTruthy();
      expect(prompt.description, prompt.name).toBeTruthy();
    }
  });

  it("takes the dial-in prompt's description from the loaded template", async () => {
    // The description used to be a string literal in the ListPrompts handler,
    // so a prompts.local.yaml override the loader honoured everywhere else was
    // invisible on the one surface a host shows the user.
    const { prompts } = await client.listPrompts();
    const advertised = prompts.find(
      (prompt) => prompt.name === "espresso_shot_analyst",
    );
    expect(advertised?.description).toBe(
      loadPrompts().espresso_shot_analyst?.description,
    );
  });

  it("derives advertised arguments from the schema that enforces them", async () => {
    const { prompts } = await client.listPrompts();
    const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));
    // A prompt taking no arguments omits the key rather than advertising [].
    expect(byName.get("espresso_shot_analyst")?.arguments).toBeUndefined();

    const args = byName.get("dial_in_new_bag")?.arguments ?? [];
    expect(
      args
        .map((arg) => [arg.name, arg.required])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["bean", true],
      ["dose_g", false],
      ["roast_level", false],
      ["target", false],
    ]);
    for (const arg of args) {
      expect(arg.description, arg.name).toBeTruthy();
    }
  });

  it("renders the dial-in prompt with the profile list interpolated", async () => {
    const text = await promptText("espresso_shot_analyst");
    expect(text).toContain("Available Profiles");
    expect(text).not.toContain("{profiles_text}");
  });

  it("serves the same guidance from the prompt and the tool", async () => {
    // Both surfaces interpolated the same template independently, in two
    // files, with the same pair of replacements — so a placeholder added to the
    // YAML would be substituted on one and left raw on the other.
    const fromPrompt = await promptText("espresso_shot_analyst");
    const fromTool = textOf(await call("get_dial_in_guidance"));
    expect(fromTool).toBe(fromPrompt);
  });

  it("interpolates the arguments a workflow prompt was given", async () => {
    const text = await promptText("dial_in_new_bag", {
      bean: "Coffee Supreme, Ethiopia Guji",
      dose_g: "18",
      roast_level: "light",
      target: "bright and tea-like",
    });
    expect(text).toContain("- Bean: Coffee Supreme, Ethiopia Guji");
    expect(text).toContain("- Dose: 18 g");
    expect(text).toContain("- Roast level: light");
    expect(text).toContain("get_dial_in_guidance");
    expect(text).not.toMatch(/\{[a-z_]+\}/);
  });

  it("tells the model what to do about an argument left blank", async () => {
    // Three shapes of "the user did not fill this in", which a host's form field
    // produces interchangeably: sent empty, sent whitespace, not sent at all.
    // Dropping the line entirely would leave the model free to invent a dose;
    // the fallback points it at the tool that actually knows.
    const text = await promptText("dial_in_new_bag", {
      bean: "some coffee",
      dose_g: "",
      target: "   ",
    });
    expect(text).toContain("- Dose: not stated");
    expect(text).toContain("recommended dose");
    expect(text).toContain("- What I want in the cup: not stated");
    expect(text).toContain("- Roast level: not stated");
  });

  it("rejects a workflow prompt missing a required argument", async () => {
    await expect(
      client.getPrompt({ name: "diagnose_last_shot" }),
    ).rejects.toThrow(/taste: missing/);
  });

  it("treats a blank required argument as missing", async () => {
    // Hosts render prompt arguments as form fields, and an untouched field
    // arrives as "" rather than not arriving at all.
    await expect(
      client.getPrompt({
        arguments: { taste: "   " },
        name: "diagnose_last_shot",
      }),
    ).rejects.toThrow(/taste: missing/);
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
    // A resource a host lists without a description is a bare URI the model has
    // to guess the contents of — the same reasoning that gives every tool one.
    for (const resource of resources) {
      expect(resource.description, resource.uri).toBeTruthy();
    }
  });

  it("reads the profile list as plain text", async () => {
    const result = await client.readResource({ uri: "gaggiuino://profiles" });
    expect(firstContent(result).mimeType).toBe("text/plain");
    expect(firstContent(result).text).toContain("Available Profiles");
  });

  it("advertises the profile template so the by-id read path is discoverable", async () => {
    // Declaring the resources capability commits the server to answering this.
    // It used to fall through to -32601, and a host that enumerates the whole
    // resource surface on a refresh treated that error as a failed refresh —
    // taking the tool list down with it.
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "gaggiuino://profiles/{id}",
    ]);
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
