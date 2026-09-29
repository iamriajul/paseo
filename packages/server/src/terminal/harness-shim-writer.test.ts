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
    expect(script).toContain('delims=;"');
    expect(script).not.toContain('delims=:"');
  });

  it("matches its own directory by substring so drive letters survive", () => {
    const script = cmdShimText();
    // %~dp0 keeps its trailing backslash, which a `;`-split segment never has,
    // so an exact segment comparison could not match and nothing was stripped.
    expect(script).toContain('set "self_dir=%~dp0"');
    expect(script).toContain("find /I /C");
  });
});
