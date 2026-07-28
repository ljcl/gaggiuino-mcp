import { writeFileSync } from "node:fs";
import { TOOLS } from "../src/server";
import { serializeToolContract, TOOL_CONTRACT_PATH } from "../src/toolContract";

// Importing `TOOLS` loads server.ts, which resolves the shot-graph MCP App at
// module scope — so this needs `bun run build` to have run at least once, the
// same prerequisite the server's tests carry.
writeFileSync(TOOL_CONTRACT_PATH, serializeToolContract(TOOLS));
console.log(`Tool contract written for ${TOOLS.length} tools.`);
