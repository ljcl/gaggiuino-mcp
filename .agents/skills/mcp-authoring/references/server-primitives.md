# Server Primitives

MCP servers expose four primitives: tools, resources, resource templates, and prompts. Understanding how to design each one so a cold model (no prior context) can use them correctly is the core skill. All examples use the TS SDK high-level `McpServer` API (`registerTool` / `registerResource` / `registerPrompt`).

## Tools

Tools are model-invoked actions. The handler returns a result with a `content` array (and optionally `structuredContent`). Unlike resources, tools can have side effects and accept arguments the model selects at runtime.

Design each tool with a single focused capability. Use an imperative `verb-noun` name so the purpose is unambiguous. Write a description that states what the tool does and exactly when to use it. Call `.describe()` on every input field so the model knows what each argument means.

Annotations are honesty hints for the host and model. Set them truthfully: `readOnlyHint` means the tool has no side effects; `destructiveHint` means it can delete or overwrite data; `idempotentHint` means calling it multiple times with the same arguments is safe; `openWorldHint` means it touches an external or unbounded system.

Validate input at the boundary. Zod enforces the shape, but check semantics yourself: ranges, existence, referential integrity, and any invariants the schema cannot express.

```typescript
server.registerTool(
  "search-orders",
  {
    title: "Search orders",
    description:
      "Search a customer's orders by status. Returns full order records so no " +
      "follow-up lookup is needed. Use when the user asks about order history.",
    inputSchema: {
      customerId: z.string().describe("Customer ID, e.g. 'cus_123'"),
      status: z
        .enum(["open", "shipped", "delivered", "cancelled"])
        .describe("Order status to filter by"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max orders to return (1-100)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ customerId, status, limit }) => {
    const orders = await db.orders.find({ customerId, status }, { limit });
    return {
      content: [{ type: "text", text: JSON.stringify(orders, null, 2) }],
    };
  },
);
```

### Structured output

When a tool returns data a caller will parse, declare an `outputSchema` and return `structuredContent` alongside a text rendering. The text is for the model to read; the structured content is for programmatic use.

```typescript
server.registerTool(
  "get-weather",
  {
    title: "Get weather",
    description: "Current weather for a city.",
    inputSchema: { city: z.string().describe("City name") },
    outputSchema: {
      tempC: z.number().describe("Temperature in Celsius"),
      conditions: z.string().describe("Short text summary, e.g. 'sunny'"),
    },
  },
  async ({ city }) => {
    const data = { tempC: 21, conditions: "sunny" };
    return {
      content: [{ type: "text", text: `${data.tempC}°C, ${data.conditions}` }],
      structuredContent: data,
    };
  },
);
```

### Error handling

Return errors as results, not thrown exceptions, so the model can recover. Set `isError: true` and put an actionable message in `content`. A thrown exception surfaces as an unrecoverable transport-level failure, which the model cannot inspect or act on.

Reserve thrown exceptions for programmer errors. Expected failures such as not found, invalid input, or upstream 4xx responses should be error results, not exceptions.

```typescript
async ({ orderId }) => {
  const order = await db.orders.get(orderId);
  if (!order) {
    return {
      isError: true,
      content: [
        { type: "text", text: `No order found with id '${orderId}'. Check the id and retry.` },
      ],
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(order) }] };
};
```

### Pagination

For potentially large lists, accept a `cursor`/`limit` and return the next cursor in `structuredContent`. Never return unbounded result sets. Document the page size in the field description so callers know what to expect.

## Resources

Resources are read-only data the client fetches by URI: config, a document, a profile. They have no side effects and no business logic beyond reading the data. Use them when the client already knows the URI and just needs the content.

A resource has a stable URI, a name, a description, and a mime type. The URI is the identity; it must be stable across calls and predictable enough that a client can construct or cache it.

```typescript
server.registerResource(
  "app-config",
  "config://app",
  {
    title: "Application config",
    description: "Read-only application configuration as JSON.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadConfig()) },
    ],
  }),
);
```

## Resource templates

Use a `ResourceTemplate` when the resource is parameterized by the URI (one per user, per document, etc.). Provide completion so clients can suggest values to the user when constructing the URI.

```typescript
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

server.registerResource(
  "user-profile",
  new ResourceTemplate("users://{userId}/profile", {
    list: undefined,
    complete: {
      userId: async (value) => (await db.users.suggestIds(value)).slice(0, 20),
    },
  }),
  { title: "User profile", description: "A user's public profile by id." },
  async (uri, { userId }) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(await db.users.get(userId)) }],
  }),
);
```

### Tool or resource?

Use a resource when the data is read-only and identified by a URI the client already knows. Use a tool when the primitive requires arguments the model chooses, or when it has side effects.

When a model needs to decide what to fetch based on runtime arguments, a tool is often the better ergonomic choice even for reads. The model can supply the arguments naturally; it cannot construct arbitrary URIs reliably.

## Prompts

Prompts are user-invoked templates surfaced by the host as a slash command or menu item. They return messages, optionally parameterized by arguments. They are not for the model to call on its own; the user triggers them explicitly.

```typescript
server.registerPrompt(
  "review-code",
  {
    title: "Review code",
    description: "Produce a focused code review of a snippet.",
    argsSchema: {
      code: z.string().describe("The code to review"),
      focus: z.string().optional().describe("Optional area to emphasize, e.g. 'security'"),
    },
  },
  ({ code, focus }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Review the following code${focus ? ` focusing on ${focus}` : ""}:\n\n${code}`,
        },
      },
    ],
  }),
);
```

## Checklist

- Use focused, imperative `verb-noun` names.
- Add `.describe()` to every input field.
- Set annotations honestly (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- Return complete data upfront so the model does not need follow-up calls.
- Return expected errors as results with `isError: true`, not thrown exceptions.
- Bound all list results with a cursor and limit.
- Use resources for known-URI reads; use tools when arguments or effects are involved.
- Register prompts only for user-invoked templates, not model-driven calls.
