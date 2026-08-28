import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Config = {
  provider: "local" | "github";
  localRoot: string;
  githubOwner: string;
  concurrency: number;
  stateDir: string;
  branchPrefix: string;
};

const DEFAULTS: Config = {
  provider: "local",
  localRoot: resolve("fleet-remotes"),
  githubOwner: "",
  concurrency: 16,
  stateDir: resolve(".fleet"),
  branchPrefix: "fleet",
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const file = resolve("fleet.config.json");
  const onDisk = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  const merged = { ...DEFAULTS, ...onDisk, ...overrides };
  merged.localRoot = resolve(merged.localRoot);
  merged.stateDir = resolve(merged.stateDir);
  return merged;
}
