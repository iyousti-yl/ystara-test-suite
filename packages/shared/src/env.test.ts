import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { COMPOSE_SETTING, envKeys, loadLocalEnv, unquotedHashKeys } from "./env.js";

const dirs: string[] = [];
const touched = ["YSTARA_TEST_PORT", "YSTARA_TEST_SECRET", "MASTER_KEY_FILE"];
function root(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ystara-env-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of touched) delete process.env[k];
});

describe("loadLocalEnv", () => {
  it("loads app settings from .env.local, $ and all", () => {
    loadLocalEnv(root({ ".env.local": "YSTARA_TEST_SECRET='pa$$word$TAIL'\n" }));
    expect(process.env.YSTARA_TEST_SECRET).toBe("pa$$word$TAIL");
  });

  it("accepts Compose port settings in .env", () => {
    loadLocalEnv(root({ ".env": "YSTARA_TEST_PORT=55433\n" }));
    expect(process.env.YSTARA_TEST_PORT).toBe("55433");
  });

  it("refuses app settings in .env and names the keys, never the values", () => {
    const dir = root({ ".env": "YSTARA_TEST_PORT=55433\nDSP_OAUTH_CLIENT_SECRET=s3cr$tTAIL\nexport DSP_HOST=https://x\n" });
    expect(() => loadLocalEnv(dir)).toThrow(/\.env contains DSP_OAUTH_CLIENT_SECRET, DSP_HOST\. .*\.env\.local/);
    try {
      loadLocalEnv(dir);
    } catch (e) {
      expect(String(e)).not.toMatch(/s3cr|TAIL|https:\/\/x/);
    }
    expect(process.env.YSTARA_TEST_PORT).toBeUndefined();
  });

  it("does nothing without settings files", () => {
    expect(() => loadLocalEnv(root({}))).not.toThrow();
    expect(process.env.MASTER_KEY_FILE).toBeUndefined();
  });

  it("points MASTER_KEY_FILE to .master-key, unless the shell names another file", () => {
    const dir = root({ ".master-key": "not read here" });
    loadLocalEnv(dir);
    expect(process.env.MASTER_KEY_FILE).toBe(path.join(dir, ".master-key"));
    process.env.MASTER_KEY_FILE = "/run/secrets/master_key";
    loadLocalEnv(dir);
    expect(process.env.MASTER_KEY_FILE).toBe("/run/secrets/master_key");
  });
});

describe("envKeys", () => {
  it("reads names only, skipping comments and blank lines", () => {
    expect(envKeys("# comment\n\nA=1\r\n  export B = '2'\nnot a setting\n")).toEqual(["A", "B"]);
  });
});

describe("docker-compose.yml", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const compose = readFileSync(path.join(repo, "docker-compose.yml"), "utf8");

  it("substitutes only Compose settings, so no app setting or secret can reach Compose's output", () => {
    const used = [...compose.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((v) => !COMPOSE_SETTING.test(v))).toEqual([]);
  });

  it("loads no env files into containers", () => {
    expect(compose).not.toMatch(/^\s*env_file\s*:/m);
  });

  // Compose reads .env before any of our programs run, so check this checkout's own .env too.
  // Only key names are compared, so a failure never prints a value. Passes when there is no .env (CI).
  it("finds only Compose settings in this checkout's .env", () => {
    const file = path.join(repo, ".env");
    const keys = existsSync(file) ? envKeys(readFileSync(file, "utf8")) : [];
    expect(keys.filter((k) => !COMPOSE_SETTING.test(k)), "move these keys from .env to .env.local").toEqual([]);
  });
});

describe("unquotedHashKeys", () => {
  it("finds a value that an unquoted # cuts short, and only for the keys asked about", () => {
    const text = ["DSP_DB_USER=SALES#SYNTH", "DSP_DB_PASSWORD='pa#ss'", "export OTHER=a#b", "DSP_SPACE=SALES # the space"].join("\n");
    expect(unquotedHashKeys(text, ["DSP_DB_USER", "DSP_DB_PASSWORD", "DSP_SPACE"])).toEqual(["DSP_DB_USER", "DSP_SPACE"]);
    expect(unquotedHashKeys('DSP_DB_USER="SALES#SYNTH"\nDSP_DB_PASSWORD=`a#b`', ["DSP_DB_USER", "DSP_DB_PASSWORD"])).toEqual([]);
  });

  it("agrees with Node's loader", () => {
    loadLocalEnv(root({ ".env.local": "YSTARA_TEST_SECRET=SALES#SYNTH\n" }));
    expect(process.env.YSTARA_TEST_SECRET).toBe("SALES");
    expect(unquotedHashKeys("YSTARA_TEST_SECRET=SALES#SYNTH", ["YSTARA_TEST_SECRET"])).toEqual(["YSTARA_TEST_SECRET"]);
  });
});
