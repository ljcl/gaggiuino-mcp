import { type Tool } from "@modelcontextprotocol/server";

/**
 * The committed record of what `tools/list` advertises.
 *
 * A host stores "always allow" against a tool's advertised identity, not
 * against the connector as a whole, so anything that changes what this server
 * says about its tools can quietly drop the grant and put the user back on a
 * permission prompt for every call. On a self-hosted server that redeploys
 * often, that is the difference between a connector that works and one that
 * nags — and it is the mechanism most likely to make a homelab install worse
 * behaved than a directory connector.
 *
 * The churn worth guarding is rarely deliberate. Nobody renames a tool by
 * accident, but the advertised JSON Schema is *generated* — `z.toJSONSchema`
 * over the same zod schemas the dispatcher enforces — so a routine `zod` or
 * `@modelcontextprotocol/sdk` bump can reshape every input schema in the server
 * without a line of this repo's code changing.
 *
 * `tool-contract.json` is that surface, committed. `server.test.ts` fails when
 * the live surface drifts from it, which turns an invisible regression into a
 * reviewable diff. Regenerating is allowed and sometimes necessary — this is
 * not a freeze. It is a receipt: the diff is the list of grants every existing
 * installation is about to lose, so it wants reviewing as a breaking change and
 * landing with a release the user can re-grant against.
 *
 * Regenerate with `bun run generate-tool-contract`.
 */
export const TOOL_CONTRACT_PATH = new URL(
  "./tool-contract.json",
  import.meta.url,
);

/**
 * Order the keys so the contract compares by content.
 *
 * A dependency bump that emits the same schema with its keys in a different
 * order is a change no host can observe, and failing on it would train everyone
 * to regenerate without reading. Array order is left alone — tool order, and
 * the order of an enum or a `required` list, are worth seeing change.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, sortDeep(inner)]),
    );
  }
  return value;
}

/** The advertised tool list reduced to comparable, order-independent JSON. */
export function normalizeToolContract(tools: Tool[]): unknown {
  return sortDeep(tools);
}

/**
 * The contract as `generate-tool-contract` writes it.
 *
 * The committed file is asserted byte-for-byte against this, which is why
 * `tool-contract.json` is excluded from Biome the way `*.schema.json` is: a
 * formatter reflowing a generated artifact would put the file permanently at
 * odds with the command that produces it.
 */
export function serializeToolContract(tools: Tool[]): string {
  return `${JSON.stringify(normalizeToolContract(tools), null, 2)}\n`;
}
