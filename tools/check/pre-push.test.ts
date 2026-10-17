import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the real pre-push hook, npm and tenant-content check, the way git does
// for a push of one commit. The commit is made with `git commit-tree` on top of
// HEAD: no branch points at it, and git cleans it up later.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = path.join(root, ".githooks", "pre-push");
// Built from parts, so this file doesn't trip the check itself when it is pushed.
const host = (first: string) => [first, "eu10", "hcs.cloud.sap"].join(".");
const identity = { GIT_AUTHOR_NAME: "Hook Test", GIT_AUTHOR_EMAIL: "hook.test@example.com", GIT_COMMITTER_NAME: "Hook Test", GIT_COMMITTER_EMAIL: "hook.test@example.com" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...identity } }).trim();

/** A commit on top of HEAD with the same files and this message. */
const commitWithMessage = (message: string) => git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message);

/**
 * Runs the hook for a push of `sha` onto a branch the remote has at HEAD. With
 * `cutOff`, its output goes into a pipe that is already closed, as with
 * `git push 2>&1 | head -30` once head has read its lines.
 */
function push(shell: string, sha: string, cutOff: boolean): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [hook, "origin", "https://example.com/synthetic.git"], { cwd: root, stdio: "pipe" });
    let output = "";
    if (cutOff) {
      child.stdout.destroy();
      child.stderr.destroy();
    } else {
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    }
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(`refs/heads/synthetic ${sha} refs/heads/synthetic ${git("rev-parse", "HEAD")}\n`);
  });
}

// Git for Windows' sh is bash; Linux and CI usually have dash as sh.
const shells = ["sh", "bash"].filter((s) => spawnSync(s, ["-c", "true"]).status === 0);

describe.skipIf(process.platform === "win32")("the pre-push hook", () => {
  it.each(shells)("stops a push with tenant content even when its output is cut off (%s)", async (shell) => {
    const sha = commitWithMessage(`Connect to ${host(`zq-${randomBytes(4).toString("hex")}`)}`);
    expect(await push(shell, sha, true)).toMatchObject({ code: 1, signal: null });
  }, 120_000);

  it("says why when the output can be read", async () => {
    const sha = commitWithMessage(`Connect to ${host(`zq-${randomBytes(4).toString("hex")}`)}`);
    const result = await push("sh", sha, false);
    expect(result.code).toBe(1);
    expect(result.output).toContain("New hits (block the push): 1");
    expect(result.output).toContain("Verdict: BLOCKED");
    expect(result.output).toContain("pre-push: push stopped.");
  }, 120_000);

  it.each(shells)("lets a clean push through, also with its output cut off (%s)", async (shell) => {
    const sha = commitWithMessage("A synthetic commit with nothing from a tenant");
    expect(await push(shell, sha, true)).toMatchObject({ code: 0, signal: null });
  }, 120_000);
});
