---
name: mcp-authoring
description: >-
  Best practices for authoring MCP (Model Context Protocol) servers and apps.
  Use when building, reviewing, debugging, or designing an MCP server or MCP app:
  choosing between tools/resources/prompts/UI, designing tool schemas and
  descriptions, adding a UI surface, securing a server with OAuth, or testing and
  evaluating MCP tools. Framework-neutral guidance; examples use the official MCP
  TypeScript SDK.
---

# Authoring MCP Servers and Apps

Guidance for building high-quality MCP servers and apps. This file is the spine:
read it first, then open the reference that matches your task. Examples use the
official MCP TypeScript SDK (`@modelcontextprotocol/sdk`); the principles apply to
any SDK. Examples target `@modelcontextprotocol/sdk` v1.x; v2 wraps tool input/output schemas in `z.object()`.

## The four primitives: when to use each

| You need                                          | Use a        | Examples                                      |
| ------------------------------------------------- | ------------ | --------------------------------------------- |
| To *do* something (effects, mutations, API calls) | **Tool**     | `send-email`, `create-issue`, `search-orders` |
| To *expose* read-only data the client can fetch   | **Resource** | app config, a user profile, a doc by URI      |
| A reusable, user-invoked interaction template     | **Prompt**   | `review-code`, `summarize-thread`             |
| A visual surface (browse, compare, select)        | **App / UI** | a results grid, a calendar, a dashboard       |

Quick rules of thumb:
- **Tool vs Resource:** a tool *acts* and is model-invoked; a resource *is data* and
  is client-fetched. If it has side effects, it is a tool.
- **Prompt:** user-initiated, not model-initiated. Surfaced as a slash command or
  menu item in the host. Don't use prompts for things the model should call itself.
- **UI:** add one when *seeing* beats *reading* (browsing many items, comparing
  side-by-side, or interactive selection). See [references/mcp-apps-ui.md](references/mcp-apps-ui.md).

## Core principles

1. **Tools for actions, resources for data, prompts for templates, UI for sight.**
   Pick the primitive that matches the intent, not the one that's easiest to wire up.
2. **One tool = one capability.** Split broad actions into focused tools.
   `create-user` / `delete-user` / `list-users`, not `manage-users`.
3. **Return complete data upfront.** Tool calls are expensive round-trips. Don't make
   the model call `list` then `get-details` N times; return the details with the list.
4. **Describe everything.** Every tool, every schema field, every resource gets a
   description written for a cold model that has never seen your service. The
   description is the API.
5. **UI owns UI-state; the server owns domain data.** Selections, filters, and tabs
   live in the UI locally, not as extra tools and not on the server.
6. **Validate at boundaries only.** Validate and sanitize user input and external API
   responses. Trust your own internal code; don't add error handling for things that
   can't happen.
7. **Prefer UI for browsing and comparing.** When in doubt and the data is visual,
   a UI surface improves the experience.

## Anti-patterns

| Bucket   | Don't                                  | Do                                                                 |
| -------- | -------------------------------------- | ------------------------------------------------------------------ |
| Tools    | Vague mega-tool (`manage-everything`)  | One focused tool per capability                                    |
| Tools    | Undescribed schema fields              | `.describe()` every field; write for a cold model                  |
| Tools    | Lazy-loading across multiple calls     | Return complete data in one response                               |
| Tools    | Throwing raw exceptions to the client  | Return an error result with an actionable message                  |
| Tools    | Omitting annotations                   | Set `readOnlyHint` / `destructiveHint` / `idempotentHint` honestly |
| UI       | UI mutates or stores domain state      | UI holds only view state; server owns data                         |
| UI       | Hardcoded colors ignoring host theme   | Read host theme/style variables                                    |
| UI       | Trusting injected data                 | Treat tool output as untrusted; sanitize before render             |
| Security | Hardcoded secrets                      | `process.env`, documented in `.env.example`                        |
| Security | Accepting any bearer token             | Validate token audience; reject tokens not issued for you          |
| Security | Forwarding the client's token upstream | Use a separate token for upstream APIs (no passthrough)            |

## Minimal server (TypeScript SDK)

A complete, well-described single-tool server over stdio:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "greeter", version: "1.0.0" });

server.registerTool(
  "greet",
  {
    title: "Greet a person",
    description: "Return a friendly greeting for the given name.",
    inputSchema: { name: z.string().describe("Name of the person to greet") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}!` }],
  }),
);

await server.connect(new StdioServerTransport());
```

## Where to go next

- **Designing tools, resources, resource templates, prompts** →
  [references/server-primitives.md](references/server-primitives.md)
- **Adding a UI surface (MCP App)** →
  [references/mcp-apps-ui.md](references/mcp-apps-ui.md)
- **Securing a server (OAuth) and general security** →
  [references/auth-and-security.md](references/auth-and-security.md)
- **Testing and evaluating your server** →
  [references/testing-and-evaluation.md](references/testing-and-evaluation.md)
