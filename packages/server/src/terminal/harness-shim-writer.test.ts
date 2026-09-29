import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ensureHarnessShims,
  resolveHarnessShimDirectory,
  buildCmdShimScript,
} from "./harness-shim-writer.js";
import type { ResolvedGatewayConfig } from "../server/agent/gateway/config.js";

const gateway: ResolvedGatewayConfig = {
  baseUrl: "http://cpa.test:8317",
  apiKey: "sk-test",
};

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "paseo-shim-test-"));
}

describe.skipIf(process.platform === "win32")("ensureHarnessShims", () => {
  it("writes an executable shim per shimmed harness", () => {
    const home = makeHome();
    const dir = ensureHarnessShims(home, gateway);
    expect(dir).toBe(resolveHarnessShimDirectory(home));

    for (const harness of ["claude", "codex", "opencode"]) {
      const file = join(dir!, harness);
      // 0o700: private file mode alone would leave the shim non-executable.
      expect(statSync(file).mode & 0o100).toBe(0o100);
    }
  });

  it("returns null when no gateway is configured", () => {
    expect(ensureHarnessShims(makeHome(), null)).toBeNull();
  });

  it("strips its own directory from PATH so the shim cannot recurse", () => {
    const home = makeHome();
    const dir = ensureHarnessShims(home, gateway)!;
    const script = readFileSync(join(dir, "codex"), "utf8");
    // Stripping self_dir is what stops `codex` from exec'ing the shim forever.
    // It must stay pure parameter expansion: the helpers cannot run once PATH
    // is rewritten.
    expect(script).toContain('[ "$entry" != "$self_dir" ]');
    expect(script).not.toMatch(/\b(tr|grep|paste|dirname)\b/);
    expect(script).toContain("exec codex");
  });

  it("bypasses injection when the opt-out env is set", () => {
    const home = makeHome();
    const dir = ensureHarnessShims(home, gateway)!;
    const script = readFileSync(join(dir, "claude"), "utf8");
    expect(script).toContain("PASEO_CLIPROXYAPI_DISABLE_SHIM");
    // The bypass branch must exec the bare binary, with no -c argv.
    const bypass = script.slice(script.indexOf("DISABLE_SHIM"));
    expect(bypass).toContain('exec claude "$@"');
  });
});

describe.skipIf(process.platform === "win32")("generated shim behavior", () => {
  it("routes through the gateway and does not recurse into itself", () => {
    const home = makeHome();
    const shimDir = ensureHarnessShims(home, gateway)!;
    const realDir = join(home, "realbin");
    // A stand-in for the real binary that reports what it was invoked with.
    writeFileSync(
      join(mkdirSync(realDir, { recursive: true }), "codex"),
      [
        "#!/bin/sh",
        `echo "MARKER_REAL_BINARY"`,
        `echo "ARGV:$*"`,
        `echo "OPENAI_BASE_URL=$OPENAI_BASE_URL"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(join(shimDir, "codex"), ["--version"], {
      encoding: "utf8",
      env: { PATH: `${shimDir}:${realDir}`, HOME: home },
    });

    // Reaching the stand-in at all proves the shim resolved past itself
    // instead of exec'ing itself forever.
    expect(result.stdout).toContain("MARKER_REAL_BINARY");
    expect(result.stdout).toContain("OPENAI_BASE_URL=http://cpa.test:8317/v1");
    expect(result.stdout).toContain("model_providers.cliproxyapi");
    expect(result.status).toBe(0);
  });

  it("runs the real binary untouched when the opt-out is set", () => {
    const home = makeHome();
    const shimDir = ensureHarnessShims(home, gateway)!;
    const realDir = join(home, "realbin");
    writeFileSync(
      join(mkdirSync(realDir, { recursive: true }), "claude"),
      ["#!/bin/sh", `echo "ARGV:$*"`, `echo "BASE=$ANTHROPIC_BASE_URL"`].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(join(shimDir, "claude"), ["--version"], {
      encoding: "utf8",
      env: {
        PATH: `${shimDir}:${realDir}`,
        HOME: home,
        PASEO_CLIPROXYAPI_DISABLE_SHIM: "1",
      },
    });

    expect(result.stdout).toContain("ARGV:--version");
    // No gateway env leaks in on the bypass path.
    expect(result.stdout).toContain("BASE=\n");
  });

  it("leaves a terminal that already routes the harness alone", () => {
    // The whole-harness rule, behaviorally: a terminal that exports its own
    // endpoint keeps it, and no gateway value leaks in alongside it.
    const home = makeHome();
    const shimDir = ensureHarnessShims(home, gateway)!;
    const realDir = join(home, "realbin");
    writeFileSync(
      join(mkdirSync(realDir, { recursive: true }), "codex"),
      ["#!/bin/sh", `echo "BASE=$OPENAI_BASE_URL"`, `echo "KEY=$OPENAI_API_KEY"`].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(join(shimDir, "codex"), [], {
      encoding: "utf8",
      env: {
        PATH: `${shimDir}:${realDir}`,
        HOME: home,
        OPENAI_BASE_URL: "https://my-own-endpoint.test",
        OPENAI_API_KEY: "sk-mine",
      },
    });

    expect(result.stdout).toContain("BASE=https://my-own-endpoint.test");
    // The key must not be silently repointed at the gateway.
    expect(result.stdout).not.toContain("sk-test");
  });

  it("leaves a key-only Codex terminal on its own endpoint", () => {
    // Guarding only on the base URL would reroute the endpoint while keeping
    // the user's personal key, sending it to the gateway. The key alone is
    // enough to mean "this terminal routes Codex itself".
    const home = makeHome();
    const shimDir = ensureHarnessShims(home, gateway)!;
    const realDir = join(home, "realbin");
    writeFileSync(
      join(mkdirSync(realDir, { recursive: true }), "codex"),
      ["#!/bin/sh", `echo "BASE=$OPENAI_BASE_URL"`, `echo "KEY=$OPENAI_API_KEY"`].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(join(shimDir, "codex"), [], {
      encoding: "utf8",
      env: { PATH: `${shimDir}:${realDir}`, HOME: home, OPENAI_API_KEY: "sk-mine" },
    });

    expect(result.stdout).toContain("KEY=sk-mine");
    expect(result.stdout).not.toContain("sk-test");
  });

  it("resolves past itself when the shell invokes it by bare name", () => {
    // This is how a real terminal reaches the shim: the user types `claude`, the
    // shell runs `command -v claude`, and PATH hands back a bare name. The shim
    // derives its own directory from $0 to strip, so that resolution has to fill
    // $0 with the PATH-resolved path. Invoking the shim by absolute path (as the
    // other tests do) would not catch it either way.
    const home = makeHome();
    const shimDir = ensureHarnessShims(home, gateway)!;
    const realDir = join(home, "realbin");
    writeFileSync(
      join(mkdirSync(realDir, { recursive: true }), "claude"),
      ["#!/bin/sh", `echo "MARKER_REAL_BINARY"`].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("/bin/sh", ["-c", "claude --version"], {
      encoding: "utf8",
      env: { PATH: `${shimDir}:${realDir}`, HOME: home },
      // A recursive shim spins until the spawn is killed, so bound it.
      timeout: 10_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("MARKER_REAL_BINARY");
  });
});

describe("cmd shim generation", () => {
  // Rendered from the same builder the daemon uses on win32, so this asserts
  // the shipped text on a machine that cannot execute it.
  function cmdShimText(): string {
    const home = makeHome();
    const dir = join(home, "cmd-shims");
    mkdirSync(dir, { recursive: true });
    return buildCmdShimScript("claude", gateway);
  }

  it("splits PATH on the Windows separator, not the POSIX one", () => {
    const script = cmdShimText();
    // `delims=:` would split `C:\Users` into `C` and `\Users`, dropping every
    // entry after the first and leaving the shim directory in PATH — which is
    // what made the wrapper resolve to itself.
    expect(script).toContain("delims=;");
    expect(script).not.toContain('delims=:"');
  });

  it("enables delayed expansion, which the strip loop's !VAR! reads depend on", () => {
    const script = cmdShimText();
    // Without it !PATH! and !stripped! are literal text, and the shim writes
    // that literal back into the real process's PATH.
    expect(script).toContain("setlocal EnableExtensions EnableDelayedExpansion");
  });

  it("reaches the real binary on both the injected and the passthrough path", () => {
    const script = cmdShimText();
    const launches = script.split("\r\n").filter((line) => line.startsWith("claude.exe"));
    // Both routes launch; the strip has to live in a subroutine, because an
    // inlined copy ends the script at its own `goto :eof` before the launch.
    expect(launches).toHaveLength(2);
    expect(script).toContain("call :stripSelfFromPath");
    // One copy only — two inlined copies collided on the subroutine labels.
    expect(script.match(/^:stripLoop$/gm)).toHaveLength(1);
    expect(script.match(/^:keepEntry$/gm)).toHaveLength(1);
  });

  it("normalizes the trailing backslash before matching its own directory", () => {
    const script = cmdShimText();
    // %~dp0 ends in a backslash that a PATH segment never has, so the two
    // sides are trimmed to a common form and compared exactly.
    expect(script).toContain('set "self_dir=%~dp0"');
    expect(script).toContain('set "self_dir=!self_dir:~0,-1!"');
    expect(script).toContain('if /I "!entry!"=="!self_dir!" goto :eof');
  });

  it("keeps the shim directory when PATH holds nothing else", () => {
    const script = cmdShimText();
    // An empty stripped result means every entry matched self. Handing the
    // child an empty PATH is worse than the recursion this guards against.
    expect(script).toContain(":restoreOriginalPath");
    expect(script).toContain('set "PATH=!self_path!"');
  });

  it("leaves a terminal that already routes the harness alone", () => {
    const script = cmdShimText();
    // Checked before the gateway env is set, so the user's own routing survives
    // instead of being overwritten by the shim.
    const guard = script.indexOf("if defined ANTHROPIC_BASE_URL goto passthrough");
    const injection = script.indexOf('set "ANTHROPIC_BASE_URL=');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(injection);
    expect(script).toContain(":passthrough");
  });

  it("tests the trailing backslash unquoted", () => {
    const script = cmdShimText();
    // cmd.exe has no escape character, so `if "x"=="\"` closes the quote early
    // and never matches — which would leave the shim directory in PATH.
    expect(script).toContain('if "!self_dir:~-1!"==\\ goto trimSelfSlash');
    expect(script).toContain('if "!entry:~-1!"==\\ set');
    expect(script).not.toContain('=="\\"');
  });

  it("sets a quoted env value without escaping its inner quotes", () => {
    // OpenCode's config content is JSON, so this runs on every launch. The
    // outer quotes delimit the value, so `set "VAR="value""` already assigns
    // `"value"`. Escaping — caret or backslash — leaves a literal \" behind and
    // makes the JSON unparseable.
    const script = buildCmdShimScript("opencode", gateway);
    expect(script).toContain('set "OPENCODE_CONFIG_CONTENT={"provider"');
    expect(script).not.toContain('\\"provider\\"');
    expect(script).not.toContain('^"provider^"');
  });
});
