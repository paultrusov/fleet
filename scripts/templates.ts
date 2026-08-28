/**
 * The service templates the synthetic fleet is generated from. Shared by the local
 * generator and the GitHub generator so both fleets are the same code.
 */
export type Shape = "flat" | "nested" | "locked";

const LODASH = ["^4.17.15", "^4.17.19", "^4.17.20", "~4.17.21", "4.17.11"];


export function files(name: string, shape: Shape, lodash: string, broken: boolean): Record<string, string> {
  const out: Record<string, string> = {};

  out["package.json"] = JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { "@acme/utils": "^2.3.0", lodash },
      devDependencies: { typescript: "^5.4.0" },
      scripts: { test: "node ci.mjs" },
    },
    null,
    2,
  ) + "\n";

  if (shape === "locked") {
    out["package-lock.json"] = JSON.stringify(
      {
        name,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name, dependencies: { "@acme/utils": "^2.3.0", lodash } },
          "node_modules/lodash": { version: lodash.replace(/^[^\d]*/, "") },
          "node_modules/@acme/utils": { version: "2.3.4" },
        },
      },
      null,
      2,
    ) + "\n";
  }

  const entry = `import { fetchData } from "@acme/utils";
import { formatDate } from "@acme/utils/date";
import { pick } from "lodash";

export type Options = { retries: number; timeoutMs: number };

// A regex migration rewrites this string too. An AST transform does not, because
// it is not a module specifier.
const ENDPOINT = "https://example.invalid/@acme/utils/v1";

export async function load(url: string, options: Options) {
  const res = await fetchData(url, options);
  return pick(res, ["id", "value"]);
}

export function describe(): string {
  return "${name} @ " + formatDate(new Date(0)) + " -> " + ENDPOINT;
}
`;

  if (shape === "nested") {
    out["src/lib/client.ts"] = entry;
    out["src/index.ts"] = `export { load, describe } from "./lib/client.ts";
export type { Options } from "./lib/client.ts";

export async function lazy() {
  const mod = await import("@acme/utils/lazy");
  return mod;
}
`;
  } else {
    out["src/index.ts"] = entry;
  }

  // Vendored stand-ins for the three packages, committed so the generated repos
  // need no network and no `npm install` to run their own CI. Both the old and the
  // new acme package exist, which is the situation a real migration is run in.
  for (const acme of ["utils", "core"]) {
    const base = `node_modules/@acme/${acme}`;
    out[`${base}/package.json`] = JSON.stringify(
      {
        name: `@acme/${acme}`,
        version: acme === "utils" ? "2.3.4" : "3.0.1",
        type: "module",
        exports: { ".": "./index.js", "./date": "./date.js", "./lazy": "./lazy.js" },
      },
      null,
      2,
    ) + "\n";
    out[`${base}/index.js`] = `export async function fetchData(url, options) {\n  return { id: url, value: options };\n}\nexport async function fetchDataV2({ url, options }) {\n  return { id: url, value: options };\n}\n`;
    out[`${base}/date.js`] = `export function formatDate(d) {\n  return d.toISOString().slice(0, 10);\n}\n`;
    out[`${base}/lazy.js`] = `export const loaded = true;\n`;
  }
  out["node_modules/lodash/package.json"] = JSON.stringify(
    { name: "lodash", version: lodash.replace(/^[^\d]*/, ""), type: "module", exports: "./index.js" },
    null,
    2,
  ) + "\n";
  out["node_modules/lodash/index.js"] =
    `export function pick(obj, keys) {\n  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));\n}\n`;

  out["tsconfig.json"] = JSON.stringify(
    { compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true }, include: ["src"] },
    null,
    2,
  ) + "\n";

  out["ci.mjs"] = broken
    ? `// This service pins the legacy adapter on purpose: its contract test asserts the
// old module path. A codemod that moves the import turns this repo red, which is
// exactly what quarantine is for.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./src/${shape === "nested" ? "lib/client" : "index"}.ts", import.meta.url), "utf8");
if (!/from "@acme\\/utils"/.test(src)) {
  console.error("contract test: this service requires the @acme/utils adapter");
  process.exit(1);
}
console.log("ok");
`
    : `import { describe } from "./src/index.ts";
const out = describe();
if (typeof out !== "string" || !out.startsWith("${name}")) {
  console.error("smoke test failed:", out);
  process.exit(1);
}
console.log("ok");
`;

  out["fleet-ci.sh"] = "#!/usr/bin/env bash\nset -euo pipefail\nnode ci.mjs\n";
  out["README.md"] = `# ${name}\n\nGenerated service (${shape}) in the fleet test harness.\n`;
  return out;
}

export function repoName(index: number): string {
  const shapes: Shape[] = ["flat", "nested", "locked"];
  return `svc-${String(index).padStart(3, "0")}-${shapes[index % shapes.length]}`;
}

export function repoShape(index: number): Shape {
  const shapes: Shape[] = ["flat", "nested", "locked"];
  return shapes[index % shapes.length]!;
}

export function repoLodash(index: number): string {
  return LODASH[index % LODASH.length]!;
}

/** ~5% of the fleet pins the old API in its own contract test and goes red on migration. */
export function repoBroken(index: number): boolean {
  return index % 20 === 7;
}

/** GitHub Actions equivalent of fleet-ci.sh, so PRs on the GitHub fleet have real checks. */
export const WORKFLOW = `name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: bash fleet-ci.sh
`;
