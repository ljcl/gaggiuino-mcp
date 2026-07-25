# Testing and Evaluation

Iterating on an MCP server means confirming that tools, resources, and prompts behave correctly and that a model can discover and use them reliably. Two loops cover this: interactive exploration to catch obvious problems fast, and automated evaluation to confirm the model-facing API stays sound across changes.

## Interactive exploration with MCP Inspector

The MCP Inspector is the standard interactive tool to connect to a server and exercise its tools, resources, and prompts by hand. Run it against a local server with `npx @modelcontextprotocol/inspector` (point it at your stdio command or HTTP URL). Use it to confirm tools list correctly, schemas render, and calls return what you expect before wiring up a host.

## Programmatic / terminal testing

For repeatable checks, drive the server with the SDK client in a small script: connect, list tools, call a tool, assert on the result. This is the fast inner loop and is CI-friendly.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "test-harness", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/server.js"] }),
);

const { tools } = await client.listTools();
const result = await client.callTool({ name: "greet", arguments: { name: "Ada" } });
// assert on `result.content` / `result.structuredContent`
```

## Writing evals

The real test of a tool is whether a cold model, given only the name, description, and schema, calls it correctly and recovers from errors. Build a small eval set: realistic user requests, the tool(s) you expect the model to call, and the expected arguments/outcome. Run it whenever you change a description or schema; descriptions are the API and regress silently. Check both directions: the model calls the right tool with the right args, and it does NOT call destructive tools when it shouldn't.

## What good looks like

- Discoverable: names and descriptions make selection obvious without trial.
- Self-describing: every field has a description; a newcomer needs no out-of-band docs.
- Complete: responses carry everything the next step needs, no forced follow-up calls.
- Graceful: errors are results with actionable messages, not crashes.
- Honest: behavior matches the annotations (a `readOnlyHint` tool truly has no effects).

## Checklist

- Exercised in Inspector.
- Scripted client test in CI.
- Eval set covering right-call and don't-call-destructive cases.
- Descriptions reviewed as API.
- Behavior matches annotations.
