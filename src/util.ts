import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };

export function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
}

/** Tokens are passed to git inside push URLs; they must never reach a log or an error. */
export function redact(text: string): string {
  return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@").replace(/gh[pous]_[A-Za-z0-9]{16,}/g, "***");
}

/** Run git and throw on a non-zero exit. Every git call in the tool goes through here. */
export async function git(args: string[], cwd?: string): Promise<string> {
  const r = await exec("git", args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.code !== 0) {
    throw new Error(redact(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`));
  }
  return r.stdout;
}

export async function gitOk(args: string[], cwd?: string): Promise<boolean> {
  const r = await exec("git", args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" } });
  return r.code === 0;
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}
