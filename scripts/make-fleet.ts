#!/usr/bin/env node
/**
 * Generate a synthetic fleet of bare git repositories to run fleet against.
 *
 * These are generated repos, not real production services. They exist so the engine
 * can be exercised and benchmarked at a realistic size without creating hundreds of
 * repositories on github.com. Templates live in templates.ts and are shared with the
 * GitHub generator, so both fleets are the same code.
 *
 *   node scripts/make-fleet.ts --count 200 --root ./fleet-remotes
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pool } from "../src/pool.ts";
import { git } from "../src/util.ts";
import { files, repoBroken, repoLodash, repoName, repoShape } from "./templates.ts";

export async function materialize(dir: string, index: number): Promise<string> {
  const name = repoName(index);
  const content = files(name, repoShape(index), repoLodash(index), repoBroken(index));
  for (const [path, body] of Object.entries(content)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
  }
  return name;
}

async function makeRepo(root: string, index: number): Promise<void> {
  const tmp = join(tmpdir(), `fleet-gen-${process.pid}-${index}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const name = await materialize(tmp, index);

  await git(["init", "-q", "-b", "main"], tmp);
  await git(["add", "-A"], tmp);
  await git(["-c", "user.name=fleet-gen", "-c", "user.email=gen@localhost", "commit", "-q", "-m", "initial commit"], tmp);

  const bare = join(root, `${name}.git`);
  await rm(bare, { recursive: true, force: true });
  await git(["clone", "--bare", "--quiet", tmp, bare]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
  await rm(tmp, { recursive: true, force: true });
}

const { values } = parseArgs({ options: { count: { type: "string", default: "200" }, root: { type: "string", default: "fleet-remotes" } } });
const count = Number(values.count);
const root = values.root!;
await mkdir(root, { recursive: true });
const started = Date.now();
let done = 0;
await pool(Array.from({ length: count }, (_, i) => i), 16, async (i) => {
  await makeRepo(root, i);
  done++;
  if (done % 10 === 0 || done === count) process.stdout.write(`\r  generated ${done}/${count}`);
});
console.log(`\n${count} repos in ${root} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
