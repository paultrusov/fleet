#!/usr/bin/env node
/**
 * Create the same synthetic fleet as make-fleet.ts, but as real repositories on
 * GitHub with a real GitHub Actions workflow, so the GitHub provider is exercised
 * against real PRs, real check runs, a real merge and a real revert.
 *
 *   node scripts/make-github-fleet.ts --owner <you> --count 6
 *   node scripts/make-github-fleet.ts --owner <you> --count 6 --delete
 *
 * Repos are private and topic-tagged `fleet-demo` unless told otherwise, so they
 * are addressable with `--select fleet-demo` and easy to remove afterwards.
 */
import { execSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pool } from "../src/pool.ts";
import { git } from "../src/util.ts";
import { files, repoBroken, repoLodash, repoName, repoShape, WORKFLOW } from "./templates.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    count: { type: "string", default: "6" },
    topic: { type: "string", default: "fleet-demo" },
    public: { type: "boolean", default: false },
    delete: { type: "boolean", default: false },
  },
});

const owner = values.owner;
if (!owner) throw new Error("--owner is required");
const count = Number(values.count);
const token = process.env.GITHUB_TOKEN ?? execSync("gh auth token", { encoding: "utf8" }).trim();

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function createRepo(index: number): Promise<string> {
  const name = repoName(index);
  const create = await api("/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: !values.public, auto_init: false, has_issues: false, has_wiki: false }),
  });
  if (!create.ok && create.status !== 422) throw new Error(`create ${name}: ${create.status} ${await create.text()}`);

  const tmp = join(tmpdir(), `fleet-gh-${process.pid}-${index}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const content = { ...files(name, repoShape(index), repoLodash(index), repoBroken(index)), ".github/workflows/ci.yml": WORKFLOW };
  for (const [path, body] of Object.entries(content)) {
    const full = join(tmp, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
  }
  await git(["init", "-q", "-b", "main"], tmp);
  await git(["add", "-A"], tmp);
  await git(["-c", "user.name=fleet-gen", "-c", "user.email=gen@localhost", "commit", "-q", "-m", "initial commit"], tmp);
  await git(["push", "--force", "--quiet", `https://x-access-token:${token}@github.com/${owner}/${name}.git`, "HEAD:refs/heads/main"], tmp);
  await rm(tmp, { recursive: true, force: true });

  await api(`/repos/${owner}/${name}/topics`, { method: "PUT", body: JSON.stringify({ names: [values.topic] }) });
  return name;
}

async function deleteRepo(index: number): Promise<string> {
  const name = repoName(index);
  const res = await api(`/repos/${owner}/${name}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`delete ${name}: ${res.status} ${await res.text()}`);
  return name;
}

const indices = Array.from({ length: count }, (_, i) => i);
let done = 0;
// Four at a time: repo creation is subject to GitHub's secondary rate limits, and
// tripping those on a fleet of this size costs more time than the throttle does.
await pool(indices, 4, async (i) => {
  const name = values.delete ? await deleteRepo(i) : await createRepo(i);
  done++;
  process.stdout.write(`\r  ${values.delete ? "deleted" : "created"} ${done}/${count}  ${name.padEnd(24)}`);
});
console.log("");
