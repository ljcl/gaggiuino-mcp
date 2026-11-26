import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockMachineStatus } from "./__fixtures__/api-responses";
import { resetClient } from "./client";
import {
  declaresFormElicitation,
  NO_INTERACTION,
  readTypedName,
} from "./confirmation";
import { setLogLevel } from "./logging";
import { connectTestClient, type McpTestClient } from "./mcpTestClient";
import { TEST_PASSPHRASE_HASH } from "./oauth/__fixtures__";
import { mockServer } from "./test-setup";

const CAPS = "io.modelcontextprotocol/clientCapabilities";
const FORM_CLIENT = { elicitation: { form: {} } };

describe("declaresFormElicitation", () => {
  it.each([
    ["bare elicitation, which means form", { elicitation: {} }, true],
    ["form named", { elicitation: { form: {} } }, true],
    ["form and url", { elicitation: { form: {}, url: {} } }, true],
    ["url only", { elicitation: { url: {} } }, false],
    ["no elicitation", {}, false],
    ["elicitation not an object", { elicitation: true }, false],
  ])("%s", (_label, capabilities, expected) => {
    expect(declaresFormElicitation({ [CAPS]: capabilities })).toBe(expected);
  });

  it("is false for an envelope with no capabilities, or no envelope", () => {
    expect(declaresFormElicitation({})).toBe(false);
    expect(declaresFormElicitation({ [CAPS]: null })).toBe(false);
    expect(declaresFormElicitation(undefined)).toBe(false);
  });
});

describe("readTypedName", () => {
  it("reads an accepted name, trimming surrounding whitespace only", () => {
    expect(
      readTypedName(
        { k: { action: "accept", content: { name: "  Zer0 " } } },
        "k",
      ),
    ).toEqual({ kind: "typed", value: "Zer0" });
  });

  it("tells a decline from a dismissal", () => {
    expect(readTypedName({ k: { action: "decline" } }, "k")).toEqual({
      kind: "declined",
    });
    expect(readTypedName({ k: { action: "cancel" } }, "k")).toEqual({
      kind: "cancelled",
    });
  });

  it("reads an absent answer, or an accept with no name, as missing", () => {
    expect(readTypedName(undefined, "k")).toEqual({ kind: "missing" });
    expect(readTypedName({ other: { action: "accept" } }, "k")).toEqual({
      kind: "missing",
    });
    expect(
      readTypedName({ k: { action: "accept", content: { name: 7 } } }, "k"),
    ).toEqual({ kind: "missing" });
  });
});

describe("NO_INTERACTION", () => {
  it("cannot ask, so a handler that asks without checking is a loud bug", async () => {
    expect(NO_INTERACTION.formElicitation).toBe(false);
    expect(NO_INTERACTION.typedName("k")).toEqual({ kind: "missing" });
    await expect(
      NO_INTERACTION.askTypedName({
        key: "k",
        message: "m",
        name: "n",
        pending: { profileId: "1", tool: "t" },
      }),
    ).rejects.toThrow("cannot ask");
  });
});

/**
 * The typed-name confirmation, over the real transport and the SDK's own
 * `requestState` verification. `deleted` records every id the DELETE verb
 * reached: for a destructive tool, "returned an error" and "deleted nothing"
 * are different claims, and these tests assert the second.
 */
describe("delete_profile's typed-name confirmation", () => {
  let deleted: string[];
  let selected: string;

  beforeEach(() => {
    resetClient({ initialDelayMs: 1 });
    vi.stubEnv("MCP_PUBLIC_URL", "https://box.tail1234.ts.net");
    vi.stubEnv("MCP_OAUTH_SECRET", "s".repeat(64));
    vi.stubEnv("MCP_OAUTH_PASSPHRASE_HASH", TEST_PASSPHRASE_HASH);
    deleted = [];
    selected = "7";
    mockServer.use(
      http.get("http://gaggiuino.local/api/profiles/all", () =>
        HttpResponse.json([
          { id: "15", name: "Zer0" },
          { id: "25", name: "Leva" },
          { id: "7", name: "Adaptive" },
        ]),
      ),
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.json([{ ...mockMachineStatus, profileId: selected }]),
      ),
      http.delete(
        "http://gaggiuino.local/api/profile-select/:id",
        ({ params }) => {
          deleted.push(String(params.id));
          return HttpResponse.text("OK");
        },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ZER0 = { confirm_name: "Zer0", profile_id: "15" };

  async function formClient(): Promise<McpTestClient> {
    return connectTestClient("form-host", undefined, FORM_CLIENT);
  }

  /** Round 1: the form, and the state to echo. */
  async function askToDelete(
    client: McpTestClient,
    args: Record<string, unknown> = ZER0,
  ) {
    const reply = await client.send("tools/call", {
      arguments: args,
      name: "delete_profile",
    });
    const result = reply.result as Record<string, unknown>;
    return {
      inputRequests: result.inputRequests as Record<
        string,
        { method: string; params: Record<string, unknown> }
      >,
      requestState: result.requestState as string,
      result,
    };
  }

  /** Round 2: the same call, with the user's answer and the echoed state. */
  async function answer(
    client: McpTestClient,
    requestState: string | undefined,
    response: Record<string, unknown> | undefined,
    args: Record<string, unknown> = ZER0,
  ) {
    return client.send("tools/call", {
      arguments: args,
      name: "delete_profile",
      ...(response ? { inputResponses: { confirm_delete: response } } : {}),
      ...(requestState === undefined ? {} : { requestState }),
    });
  }

  function textOf(reply: { result?: unknown }): string {
    const content = (reply.result as { content?: Array<{ text: string }> })
      .content;
    return content?.[0]?.text ?? "";
  }

  it("asks the user to type the name on round 1, and deletes nothing", async () => {
    const client = await formClient();
    const { inputRequests, requestState, result } = await askToDelete(client);
    expect(result.resultType).toBe("input_required");
    expect(typeof requestState).toBe("string");
    const request = inputRequests.confirm_delete;
    expect(request?.method).toBe("elicitation/create");
    expect(String(request?.params.message)).toContain("'Zer0'");
    expect(String(request?.params.message)).toContain("cannot be undone");
    expect(request?.params.requestedSchema).toMatchObject({
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(deleted).toEqual([]);
  });

  it("deletes when the user types the exact name", async () => {
    const client = await formClient();
    const { requestState } = await askToDelete(client);
    const reply = await answer(client, requestState, {
      action: "accept",
      content: { name: "Zer0" },
    });
    expect(textOf(reply)).toContain("Deleted 'Zer0'");
    expect(deleted).toEqual(["15"]);
  });

  it("refuses a name that differs in case, and deletes nothing", async () => {
    const client = await formClient();
    const { requestState } = await askToDelete(client);
    const reply = await answer(client, requestState, {
      action: "accept",
      content: { name: "zer0" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(reply)).toContain("did not match");
    expect(deleted).toEqual([]);
  });

  it("treats a decline and a dismissal as answers, and deletes nothing", async () => {
    for (const action of ["decline", "cancel"]) {
      const client = await formClient();
      const { requestState } = await askToDelete(client);
      const reply = await answer(client, requestState, { action });
      expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
      expect(textOf(reply)).toContain("Not deleted");
      expect(textOf(reply)).toContain("unless the user asks");
    }
    expect(deleted).toEqual([]);
  });

  it("refuses a round 2 that carries no answer, and deletes nothing", async () => {
    const client = await formClient();
    const { requestState } = await askToDelete(client);
    const reply = await answer(client, requestState, undefined);
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(reply)).toContain("without the user's answer");
    expect(deleted).toEqual([]);
  });

  it("answers -32602 for a forged state before the handler runs", async () => {
    const client = await formClient();
    const reply = await answer(client, "not-a-state-this-server-signed", {
      action: "accept",
      content: { name: "Zer0" },
    });
    expect(reply.error?.code).toBe(-32602);
    expect(deleted).toEqual([]);
  });

  it("cannot skip round 1: an answer with no state gets the form", async () => {
    // A client that fabricates `inputResponses` without the state this server
    // signed lands on round 1 again, so an answer only counts as a reply to a
    // question this server asked.
    const client = await formClient();
    const reply = await answer(client, undefined, {
      action: "accept",
      content: { name: "Zer0" },
    });
    expect((reply.result as Record<string, unknown>).resultType).toBe(
      "input_required",
    );
    expect(deleted).toEqual([]);
  });

  it("refuses a state minted for another profile, and deletes nothing", async () => {
    // The state is genuine — signed here, unexpired — but it was minted for
    // id 15 and is spent on a call for id 25 with that profile's own name.
    const client = await formClient();
    const { requestState } = await askToDelete(client);
    const reply = await answer(
      client,
      requestState,
      { action: "accept", content: { name: "Leva" } },
      { confirm_name: "Leva", profile_id: "25" },
    );
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(reply)).toContain("different request");
    expect(deleted).toEqual([]);
  });

  it("re-checks the selected profile on round 2, against the machine as it is now", async () => {
    const client = await formClient();
    const { requestState } = await askToDelete(client);
    selected = "15";
    const reply = await answer(client, requestState, {
      action: "accept",
      content: { name: "Zer0" },
    });
    expect(textOf(reply)).toContain("currently has selected");
    expect(deleted).toEqual([]);
  });

  it("keeps today's single call on a host without form elicitation", async () => {
    for (const capabilities of [{}, { elicitation: { url: {} } }]) {
      deleted = [];
      const client = await connectTestClient(
        "no-form-host",
        undefined,
        capabilities,
      );
      const reply = await client.send("tools/call", {
        arguments: ZER0,
        name: "delete_profile",
      });
      expect(textOf(reply)).toContain("Deleted 'Zer0'");
      expect(deleted).toEqual(["15"]);
    }
  });

  it("logs the form and the user's answer as their own outcomes", async () => {
    setLogLevel("info");
    const records: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      records.push(JSON.parse(String(line)));
    });
    try {
      const client = await formClient();
      const { requestState } = await askToDelete(client);
      await answer(client, requestState, { action: "decline" });
    } finally {
      spy.mockRestore();
      setLogLevel("silent");
    }
    const outcomes = records
      .filter((record) => record.event === "tool.call")
      .map((record) => record.outcome);
    expect(outcomes).toEqual(["input_required", "declined"]);
  });
});
