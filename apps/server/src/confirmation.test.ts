import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockMachineStatus,
  mockProfileDefinition,
} from "./__fixtures__/api-responses";
import { resetClient } from "./client";
import {
  declaresFormElicitation,
  NO_INTERACTION,
  readChoice,
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

describe("readChoice", () => {
  it("reads the chosen value as sent, untrimmed, for the caller to check", () => {
    expect(
      readChoice({ k: { action: "accept", content: { choice: "25" } } }, "k"),
    ).toEqual({ kind: "chosen", value: "25" });
  });

  it("reads a decline, a dismissal, and an accept with no choice", () => {
    expect(readChoice({ k: { action: "decline" } }, "k")).toEqual({
      kind: "declined",
    });
    expect(readChoice({ k: { action: "cancel" } }, "k")).toEqual({
      kind: "cancelled",
    });
    expect(
      readChoice({ k: { action: "accept", content: { choice: 25 } } }, "k"),
    ).toEqual({ kind: "missing" });
  });
});

describe("NO_INTERACTION", () => {
  it("cannot ask, so a handler that asks without checking is a loud bug", async () => {
    expect(NO_INTERACTION.formElicitation).toBe(false);
    expect(NO_INTERACTION.typedName("k")).toEqual({ kind: "missing" });
    expect(NO_INTERACTION.choice("k")).toEqual({ kind: "missing" });
    await expect(
      NO_INTERACTION.askChoice({
        key: "k",
        message: "m",
        options: [],
        pending: { candidates: [], kind: "pick", query: "q", tool: "t" },
      }),
    ).rejects.toThrow("cannot ask");
    await expect(
      NO_INTERACTION.askTypedName({
        key: "k",
        message: "m",
        name: "n",
        pending: { kind: "confirm", profileId: "1", tool: "t" },
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

/**
 * Which copy, when a name matches more than one profile. The machine does not
 * enforce unique names, so two profiles called "Zer0" are a real state. Every
 * test counts what reached the machine, because "asked a question" and "acted
 * on a copy nobody chose" look the same from the reply alone.
 */
describe("picking between profiles that share a name", () => {
  // `id` optional: a firmware can send profiles without one.
  let profiles: Array<{ id?: string; name: string }>;
  let selectedIds: string[];
  let deletedIds: string[];
  let definitionReads: string[];

  beforeEach(() => {
    resetClient({ initialDelayMs: 1 });
    vi.stubEnv("MCP_PUBLIC_URL", "https://box.tail1234.ts.net");
    vi.stubEnv("MCP_OAUTH_SECRET", "s".repeat(64));
    vi.stubEnv("MCP_OAUTH_PASSPHRASE_HASH", TEST_PASSPHRASE_HASH);
    profiles = [
      { id: "15", name: "Zer0" },
      { id: "25", name: "Zer0" },
      { id: "7", name: "Adaptive" },
    ];
    selectedIds = [];
    deletedIds = [];
    definitionReads = [];
    mockServer.use(
      http.get("http://gaggiuino.local/api/profiles/all", () =>
        HttpResponse.json(profiles),
      ),
      http.get("http://gaggiuino.local/api/system/status", () =>
        HttpResponse.json([{ ...mockMachineStatus, profileId: "7" }]),
      ),
      http.get("http://gaggiuino.local/api/profile/:id", ({ params }) => {
        definitionReads.push(String(params.id));
        return HttpResponse.json({ ...mockProfileDefinition, id: params.id });
      }),
      http.post(
        "http://gaggiuino.local/api/profile-select/:id",
        ({ params }) => {
          selectedIds.push(String(params.id));
          return HttpResponse.text("OK");
        },
      ),
      http.delete(
        "http://gaggiuino.local/api/profile-select/:id",
        ({ params }) => {
          deletedIds.push(String(params.id));
          return HttpResponse.text("OK");
        },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  interface Round {
    error?: { code: number };
    inputRequests?: Record<
      string,
      { method: string; params: Record<string, unknown> }
    >;
    isError?: boolean;
    requestState?: string;
    resultType?: string;
    structuredContent?: Record<string, unknown>;
    text: string;
  }

  /** One `tools/call`, with an answer and a state when it is a later round. */
  async function call(
    client: McpTestClient,
    name: string,
    args: Record<string, unknown>,
    answer?: { key: string; requestState: string; response: unknown },
  ): Promise<Round> {
    const reply = await client.send("tools/call", {
      arguments: args,
      name,
      ...(answer
        ? {
            inputResponses: { [answer.key]: answer.response },
            requestState: answer.requestState,
          }
        : {}),
    });
    const result = (reply.result ?? {}) as Record<string, unknown>;
    const content = result.content as Array<{ text: string }> | undefined;
    return {
      error: reply.error,
      inputRequests: result.inputRequests as Round["inputRequests"],
      isError: result.isError as boolean | undefined,
      requestState: result.requestState as string | undefined,
      resultType: result.resultType as string | undefined,
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
      text: content?.[0]?.text ?? "",
    };
  }

  function pick(round: Round, value: string) {
    return {
      key: "pick_profile",
      requestState: round.requestState ?? "",
      response: { action: "accept", content: { choice: value } },
    };
  }

  const formClient = () =>
    connectTestClient("form-host", undefined, FORM_CLIENT);

  it("asks which copy, with one option per copy, and selects nothing", async () => {
    const client = await formClient();
    const round = await call(client, "select_profile", { profile_id: "Zer0" });
    expect(round.resultType).toBe("input_required");
    const request = round.inputRequests?.pick_profile;
    expect(request?.method).toBe("elicitation/create");
    expect(String(request?.params.message)).toContain("2 profiles");
    const schema = request?.params.requestedSchema as {
      properties: {
        choice: { oneOf: Array<{ const: string; title: string }> };
      };
    };
    expect(
      schema.properties.choice.oneOf.map((option) => option.const),
    ).toEqual(["15", "25"]);
    expect(schema.properties.choice.oneOf[1]?.title).toContain("25");
    expect(selectedIds).toEqual([]);
  });

  it("selects the copy the user picked", async () => {
    const client = await formClient();
    const first = await call(client, "select_profile", { profile_id: "Zer0" });
    const second = await call(
      client,
      "select_profile",
      { profile_id: "Zer0" },
      pick(first, "25"),
    );
    expect(second.isError).toBeUndefined();
    expect(selectedIds).toEqual(["25"]);
  });

  it("refuses an answer that is not one of the copies offered", async () => {
    // "7" is a real profile, but the signed state offered 15 and 25 only.
    const client = await formClient();
    const first = await call(client, "select_profile", { profile_id: "Zer0" });
    const second = await call(
      client,
      "select_profile",
      { profile_id: "Zer0" },
      pick(first, "7"),
    );
    expect(second.isError).toBe(true);
    expect(selectedIds).toEqual([]);
  });

  it("treats a decline or a dismissal as no choice, and selects nothing", async () => {
    for (const action of ["decline", "cancel"]) {
      const client = await formClient();
      const first = await call(client, "select_profile", {
        profile_id: "Zer0",
      });
      const second = await call(
        client,
        "select_profile",
        { profile_id: "Zer0" },
        {
          key: "pick_profile",
          requestState: first.requestState ?? "",
          response: { action },
        },
      );
      expect(second.isError).toBe(true);
      expect(second.text).toContain("did not choose");
      expect(second.text).toContain("Nothing was selected");
    }
    expect(selectedIds).toEqual([]);
  });

  it("refuses a pick whose copy left the machine while the form was open", async () => {
    const client = await formClient();
    const first = await call(client, "select_profile", { profile_id: "Zer0" });
    profiles = [
      { id: "15", name: "Zer0" },
      { id: "7", name: "Adaptive" },
    ];
    resetClient({ initialDelayMs: 1 }); // drop the cached profile list
    const second = await call(
      client,
      "select_profile",
      { profile_id: "Zer0" },
      pick(first, "25"),
    );
    expect(second.isError).toBe(true);
    expect(second.text).toContain("no longer on the machine");
    expect(selectedIds).toEqual([]);
  });

  it("reads the definition of the picked copy, and of no other", async () => {
    const client = await formClient();
    const first = await call(client, "get_profile_info", {
      profile_id: "zer0",
    });
    expect(first.resultType).toBe("input_required");
    expect(definitionReads).toEqual([]);
    const second = await call(
      client,
      "get_profile_info",
      { profile_id: "zer0" },
      pick(first, "25"),
    );
    expect(second.structuredContent?.machineProfileId).toBe("25");
    expect(definitionReads).toEqual(["25"]);
  });

  it("does not let one tool's pick answer another tool's question", async () => {
    const client = await formClient();
    const first = await call(client, "select_profile", { profile_id: "Zer0" });
    const second = await call(
      client,
      "get_profile_info",
      { profile_id: "Zer0" },
      pick(first, "25"),
    );
    // A fresh question, not the definition of the copy picked for selection.
    expect(second.resultType).toBe("input_required");
    expect(definitionReads).toEqual([]);
  });

  it("deletes only after a pick and then the typed name, three rounds", async () => {
    const args = { confirm_name: "Zer0", profile_id: "zer0" };
    const client = await formClient();

    const first = await call(client, "delete_profile", args);
    expect(first.inputRequests?.pick_profile).toBeDefined();

    // The pick leads to the typed-name question, never to the DELETE.
    const second = await call(
      client,
      "delete_profile",
      args,
      pick(first, "25"),
    );
    expect(second.resultType).toBe("input_required");
    expect(
      String(second.inputRequests?.confirm_delete?.params.message),
    ).toContain("machine profile id 25");
    expect(deletedIds).toEqual([]);

    const third = await call(client, "delete_profile", args, {
      key: "confirm_delete",
      requestState: second.requestState ?? "",
      response: { action: "accept", content: { name: "Zer0" } },
    });
    expect(third.text).toContain("Deleted 'Zer0' (machine profile id 25)");
    expect(deletedIds).toEqual(["25"]);
  });

  it("refuses a pick that came back without a choice", async () => {
    const client = await formClient();
    const first = await call(client, "select_profile", { profile_id: "Zer0" });
    const second = await call(
      client,
      "select_profile",
      { profile_id: "Zer0" },
      {
        key: "pick_profile",
        requestState: first.requestState ?? "",
        response: { action: "accept", content: {} },
      },
    );
    expect(second.isError).toBe(true);
    expect(second.text).toContain("without a choice");
    expect(selectedIds).toEqual([]);
  });

  it("refuses a declined pick on a read, without claiming anything was undone", async () => {
    const client = await formClient();
    const first = await call(client, "get_profile_info", {
      profile_id: "Zer0",
    });
    const second = await call(
      client,
      "get_profile_info",
      { profile_id: "Zer0" },
      {
        key: "pick_profile",
        requestState: first.requestState ?? "",
        response: { action: "decline" },
      },
    );
    expect(second.isError).toBe(true);
    expect(second.text).toContain("did not choose");
    expect(second.text).not.toContain("Nothing was");
    expect(definitionReads).toEqual([]);
  });

  it("does not let a delete's typed-name state select a profile", async () => {
    // The `confirm` state names copy 25 and is genuine, but delete_profile
    // minted it; spent on select_profile it must not stand in for a pick.
    const args = { confirm_name: "Zer0", profile_id: "Zer0" };
    const client = await formClient();
    const first = await call(client, "delete_profile", args);
    const second = await call(
      client,
      "delete_profile",
      args,
      pick(first, "25"),
    );
    const third = await call(
      client,
      "select_profile",
      { profile_id: "Zer0" },
      {
        key: "confirm_delete",
        requestState: second.requestState ?? "",
        response: { action: "accept", content: { name: "Zer0" } },
      },
    );
    expect(third.resultType).toBe("input_required");
    expect(selectedIds).toEqual([]);
    expect(deletedIds).toEqual([]);
  });

  it("keeps the refusal when the copies have no machine profile id to pick", async () => {
    // A firmware that sends no ids: two "Zer0" rows, neither addressable, so
    // there is nothing to offer and nothing a pick could act on.
    profiles = [{ name: "Zer0" }, { name: "Zer0" }];
    const client = await formClient();
    const round = await call(client, "select_profile", { profile_id: "Zer0" });
    expect(round.resultType).not.toBe("input_required");
    expect(round.isError).toBe(true);
    expect(selectedIds).toEqual([]);
  });

  it("keeps today's refusal, naming both copies, on a host without forms", async () => {
    const client = await connectTestClient("no-form-host");
    const round = await call(client, "select_profile", { profile_id: "Zer0" });
    expect(round.isError).toBe(true);
    expect(round.text).toContain("machineProfileId 15");
    expect(round.text).toContain("machineProfileId 25");
    expect(selectedIds).toEqual([]);
  });
});
