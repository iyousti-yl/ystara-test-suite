import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMPOSE_SETTING, envKeys, loadLocalEnv, settingFromEnv, unquotedHashKeys } from "./env.js";

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

describe("settingFromEnv", () => {
  it("reads the file NAME_FILE names, without its final line break, before NAME", () => {
    const dir = root({ "database_url": "postgres://u:p@db:5432/ystara\n" });
    const env = { DATABASE_URL_FILE: path.join(dir, "database_url"), DATABASE_URL: "postgres://other" };
    expect(settingFromEnv("DATABASE_URL", env)).toBe("postgres://u:p@db:5432/ystara");
  });

  it("falls back to NAME, and to nothing", () => {
    expect(settingFromEnv("SMTP_URL", { SMTP_URL: "smtp://mail:1025" })).toBe("smtp://mail:1025");
    expect(settingFromEnv("SMTP_URL", {})).toBeUndefined();
  });

  it("names a missing file, never a value", () => {
    expect(() => settingFromEnv("SMTP_URL", { SMTP_URL_FILE: "/nowhere/smtp_url" })).toThrow("SMTP_URL_FILE names /nowhere/smtp_url, which doesn't exist.");
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

describe("deploy/docker-compose.prod.yml", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const text = readFileSync(path.join(repo, "deploy", "docker-compose.prod.yml"), "utf8");
  // Compose's own tags (!override, !reset) are read as plain values here, which is all these checks need.
  const prod = parse(text, { logLevel: "error", merge: true }) as {
    services: Record<string, { ports?: string[]; environment?: Record<string, string>; secrets?: string[] }>;
    secrets: Record<string, { file: string }>;
  };

  it("substitutes only Compose settings and loads no env files", () => {
    const used = [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    expect(used.filter((v) => !COMPOSE_SETTING.test(v))).toEqual([]);
    expect(text).not.toMatch(/^\s*env_file\s*:/m);
  });

  it("opens only Caddy to the outside: Postgres and the API publish no port", () => {
    const published = Object.entries(prod.services).filter(([, s]) => s.ports?.length).map(([name]) => name);
    expect(published).toEqual(["caddy"]);
    expect(prod.services.postgres.ports).toEqual([]);
    expect(prod.services.api.ports).toEqual([]);
  });

  it("puts no password in an environment variable: each comes from a file in the secrets folder", () => {
    for (const [name, service] of Object.entries(prod.services)) {
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        expect(`${name}.${key}=${value}`).not.toMatch(/PASSWORD=|postgres:\/\/|smtps?:\/\//);
      }
      for (const secret of service.secrets ?? []) expect(prod.secrets[secret], `${name} uses ${secret}`).toBeDefined();
    }
    for (const secret of Object.values(prod.secrets)) expect(secret.file).toMatch(/^\$\{YSTARA_SECRETS:-\/etc\/ystara\/secrets\}\//);
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
