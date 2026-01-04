import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ProfilesSchema, PromptsSchema } from "../src/loader";

const dataDir = new URL("../src/data/", import.meta.url);

writeFileSync(
  new URL("profiles.schema.json", dataDir),
  `${JSON.stringify(z.toJSONSchema(ProfilesSchema), null, 2)}\n`,
);
writeFileSync(
  new URL("prompts.schema.json", dataDir),
  `${JSON.stringify(z.toJSONSchema(PromptsSchema), null, 2)}\n`,
);
console.log("Schemas generated.");
