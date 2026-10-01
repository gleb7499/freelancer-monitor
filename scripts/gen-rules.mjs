// Generates src/generated/rules.ts from rules/*.md so the LLM prompts are built
// from the markdown source of truth instead of inlined copies.
// Runs automatically before `typecheck` and `deploy` (npm pre-hooks).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = {
  RULES_FREELANCER_SELECTION: "rules/freelancer-правила-отбора.md",
  RULES_BID_SKILL: "rules/отклик-скилл.md",
};

let out = "// GENERATED FILE — do not edit. Source: rules/*.md (npm run gen:rules)\n";
for (const [name, rel] of Object.entries(SOURCES)) {
  const text = readFileSync(join(root, rel), "utf8").trim();
  out += `export const ${name} = ${JSON.stringify(text)};\n\n`;
}

const target = join(root, "src", "generated", "rules.ts");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out);
console.log(
  `gen-rules: wrote ${Object.keys(SOURCES).length} rules into src/generated/rules.ts ` +
    `(${out.length} bytes)`,
);
