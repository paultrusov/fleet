import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Transform } from "./types.ts";

type Manifest = Record<string, Record<string, string> | undefined>;
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Bump one dependency in package.json and keep package-lock.json consistent, so
 * the PR is installable rather than a manifest that no longer matches its lock.
 */
export const bumpDep: Transform = {
  name: "bump-dep",
  describe: "Bump a dependency to a new range in package.json and update package-lock.json",
  requiredArgs: ["pkg", "to"],

  async apply(dir, args) {
    const pkg = args.pkg!;
    const to = args.to!;
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) return { changed: false, summary: "no package.json" };

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    const hits: string[] = [];
    for (const field of FIELDS) {
      const deps = manifest[field];
      if (deps && deps[pkg] !== undefined && deps[pkg] !== to) {
        hits.push(`${field}: ${deps[pkg]} -> ${to}`);
        deps[pkg] = to;
      }
    }
    if (hits.length === 0) return { changed: false, summary: `${pkg} absent or already ${to}` };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const lockPath = join(dir, "package-lock.json");
    if (existsSync(lockPath)) {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
      };
      const pinned = to.replace(/^[\^~>=<\s]+/, "");
      for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        if (path === `node_modules/${pkg}`) entry.version = pinned;
        if (entry.dependencies?.[pkg] !== undefined) entry.dependencies[pkg] = to;
      }
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }

    return { changed: true, summary: hits.join("; ") };
  },
};
