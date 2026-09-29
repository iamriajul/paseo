import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  it("pins for /f's end-of-line to ; explicitly rather than by default", () => {
    const script = cmdShimText();
    // eol=; is cmd's default, so this asserts nothing about behavior — it pins
    // the value so a later reader does not "fix" the delimiter on the belief
    // that the two interact. The default eol governs *file* parsing, where it
    // drops `;`-prefixed comment lines; a quoted literal string is one line, and
    // only `delims` splits it. BuildXL's CopyCMakeDeps.bat and leiningen's
    // lein.bat walk PATH with this exact form.
    expect(script).toContain('for /f "tokens=1* delims=; eol=;"');
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
    expect(script).toContain("if defined stripped goto keepStripped");
    expect(script).toContain('set "new_path=!self_path!"');
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

  it("scopes delayed expansion to the strip, so a ! in a value survives", () => {
    const script = cmdShimText();
    // The API key comes from user config. With delayed expansion on for the
    // whole script, cmd would consume any `!` in it and hand the harness an
    // altered credential — so it is enabled inside the subroutine only, and
    // endlocal runs before the launch.
    const setline = script.indexOf('set "ANTHROPIC_BASE_URL=');
    const enable = script.indexOf("setlocal EnableExtensions EnableDelayedExpansion");
    expect(enable).toBeGreaterThan(setline);
    expect(script).toContain('endlocal & set "PATH=%new_path%"');
  });

  it("keeps the env set before the strip scope opens", () => {
    const script = cmdShimText();
    // Order matters twice over: the values must be set outside the setlocal
    // that enables delayed expansion, and before the passthrough guards would
    // have skipped them.
    const guard = script.indexOf("if defined ANTHROPIC_BASE_URL goto passthrough");
    const setline = script.indexOf('set "ANTHROPIC_BASE_URL=');
    const call = script.indexOf("call :stripSelfFromPath");
    expect(guard).toBeLessThan(setline);
    expect(setline).toBeLessThan(call);
  });

  it("tests the trailing backslash unquoted", () => {
    const script = cmdShimText();
    // cmd.exe has no escape character, so `if "x"=="\"` closes the quote early
    // and never matches — which would leave the shim directory in PATH.
    expect(script).toContain('if "!self_dir:~-1!"==\\ goto trimSelfSlash');
    expect(script).toContain('if "!entry:~-1!"==\\ set');
    expect(script).not.toContain('=="\\"');
  });
});

describe.skipIf(process.platform !== "win32")("generated cmd shim behavior", () => {
  // The text assertions above cannot settle what cmd.exe actually does with
  // `set "K=V"` when V contains quotes, nor whether the script reaches the real
  // binary at all. These run the generated script for real on Windows CI, which
  // is the only place the answer is knowable.
  //
  // The shim launches `<harness>.exe`, and cmd appends PATHEXT only to
  // extensionless names — so `claude.exe` will not resolve to `claude.exe.bat`.
  // The stand-in has to be named `claude.exe` exactly, and it has to be a real
  // PE: a batch script under that name is rejected by the loader with
  // `%1 is not a valid Win32 application`, so the launch would fail whatever
  // the shim did. An earlier version of this test staged one anyway, on the
  // claim that "the loader is lenient about the mismatch". That was never
  // checked, and it was wrong — it made these tests pass for reasons that had
  // nothing to do with the shim. `%ComSpec%` is a real PE on every Windows
  // install, so it is copied under the harness name. Staging a batch script
  // instead would test cmd's loader, not the shim.
  //
  // A copied cmd.exe is a faithful stand-in: the shim runs it with the same
  // argv any harness would get, and the batch lines below are what the copied
  // exe then executes.
  function stageShim(harness: "claude" | "codex" | "opencode"): {
    shimDir: string;
    // A realistic PATH, so the strip loop has entries to keep and the
    // restore-only-the-shim-dir branch is not the path under test.
    testPath: string;
    // PATH as the shim should have left it, for asserting the strip kept
    // everything it was supposed to.
    keepDir: string;
    // The script the copied cmd.exe runs. Passed to the shim as an argument.
    probeScript: string;
    read: (name: string) => string;
  } {
    const home = makeHome();
    const shimDir = join(home, "shims");
    const keepDir = join(home, "keep");
    // Two decoy entries on top of the two that matter, so a strip that keeps
    // only one entry and discards the rest still leaves the stand-in findable
    // and passes. A four-entry PATH is what closes that shape. The real Windows
    // PATH has System32 and friends in it, and losing those is the actual
    // damage.
    const decoyA = join(home, "decoy-a");
    const decoyB = join(home, "decoy-b");
    for (const dir of [shimDir, keepDir, decoyA, decoyB]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(shimDir, `${harness}.cmd`), buildCmdShimScript(harness, gateway));

    // Each probe writes its own file: two echos into one path mean the second
    // silently overwrites the first, and an unset var leaves an empty file that
    // reads the same as a missing launch.
    const out = (name: string) => join(home, `${name}.txt`);
    // The stand-in lives in keepDir, not shimDir. The shim strips its own
    // directory from PATH before launching, so a binary staged beside the shim
    // is unresolvable the moment the strip works — the test would fail against
    // a correct shim. keepDir is the entry that has to survive the strip.
    //
    // The copy of cmd.exe is invoked with the probe script as its argument, so
    // `%*` carrying it through the shim is load-bearing: a shim that dropped the
    // user's arguments would launch the copy with nothing to run and write no
    // probe. That is a real shim bug this now catches.
    const probeScript = join(home, "probe.cmd");
    writeFileSync(
      probeScript,
      [
        "@echo off",
        "echo MARKER_REAL_BINARY",
        // The PATH the shim actually handed down, so the test can check the
        // strip kept the decoys instead of only the entry holding the binary.
        `echo %PATH%>${out("path")}`,
        `echo %OPENCODE_CONFIG_CONTENT%>${out("config")}`,
        `echo %OPENAI_BASE_URL%>${out("base")}`,
        "exit /b 0",
      ].join("\r\n"),
    );
    const exe = join(keepDir, `${harness}.exe`);
    copyFileSync(cmdExePath(), exe);
    return {
      shimDir,
      testPath: [shimDir, keepDir, decoyA, decoyB].join(";"),
      keepDir,
      probeScript,
      // A missing probe file means the binary never ran, which reads as a shim
      // bug. Name it here instead of letting readFileSync throw ENOENT.
      read: (name) => {
        const file = out(name);
        if (!existsSync(file)) return `<<${name}.txt never written: the binary did not run>>`;
        return readFileSync(file, "utf8").trim();
      },
    };
  }

  // PATH is narrowed to the shim directory so the shim is what resolves, but
  // that leaves no way to find cmd.exe itself — PATH is also how the child
  // process is located, so it has to be named absolutely. SystemRoot goes
  // along for the ride because cmd refuses to start without it.
  function cmdExePath(): string {
    return (
      process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe")
    );
  }

  function spawnShim(
    harness: string,
    testPath: string,
    env: NodeJS.ProcessEnv = {},
    args: string[] = [],
  ) {
    // Everything after `/c` must reach cmd as ONE string. Spread across argv,
    // cmd reads the rest of the vector as the command text: it reports a
    // missing message number and prints the working directory, which is how the
    // first Windows run of these tests failed with an empty result. The `/c`
    // line is joined here for the same reason terminal.ts joins it rather than
    // handing node-pty an argv array.
    //
    // The probe path is quoted so the spaces mkdtemp's Temp directory carries
    // survive cmd's tokenizer.
    const commandLine = [harness, ...args.map((arg) => `"${arg}"`)].join(" ");
    const result = spawnSync(cmdExePath(), ["/d", "/s", "/c", commandLine], {
      encoding: "utf8",
      // shim first: a shim that failed to strip itself recurses until killed.
      //
      // PATHEXT is the variable that makes a bare `claude` reach `claude.cmd`
      // at all — cmd only appends PATHEXT to extensionless names — and this
      // env is built from scratch, so it does not inherit one. Without it the
      // bare name resolves to nothing, the shim never runs, and every test here
      // fails identically with no output and no probe files, which reads like a
      // shim bug rather than a missing variable. Inheriting the runner's
      // PATHEXT keeps these tests on the same footing as a real terminal,
      // which inherits the daemon's whole environment.
      env: {
        PATH: testPath,
        SystemRoot: process.env.SystemRoot,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        ...env,
      },
      timeout: 20_000,
    });
    // A missing shell looks like a passing shim (null status, no marker), so
    // say so plainly rather than letting the assertion below report it.
    if (result.error) throw result.error;
    // cmd writes a bare `not recognized as an internal or external command` to
    // stdout for an unresolvable name, and nothing at all explains it in the
    // assertion that follows. Fold stderr in so the failure names the cause.
    return { ...result, stdout: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  }

  it("hands OpenCode parseable JSON, settling how set treats inner quotes", () => {
    const { testPath, probeScript, read } = stageShim("opencode");
    const result = spawnShim("opencode", testPath, {}, [probeScript]);
    // A shim that never launched the binary, or launched one that failed, is
    // not a pass. Asserting the marker first means the JSON below is read from
    // a run that actually reached the stand-in.
    expect(result.stdout).toContain("MARKER_REAL_BINARY");
    expect(result.status).toBe(0);

    // If the value were escaped, this JSON.parse is what fails. The security
    // review says a bare quote terminates the set command; the reviewer says it
    // does not. Whichever is true, the parse decides it.
    const config = JSON.parse(read("config"));
    expect(config.provider.cliproxyapi.options.baseURL).toBe("http://cpa.test:8317/v1");
    expect(config.provider.cliproxyapi.options.apiKey).toBe("sk-test");
  });

  it("reaches the real binary instead of resolving to itself", () => {
    const { testPath, probeScript } = stageShim("claude");
    const result = spawnShim("claude", testPath, {}, [probeScript]);
    // The marker only prints from the stand-in, so its absence means the shim
    // ended at its own `goto :eof` instead of launching.
    expect(result.stdout).toContain("MARKER_REAL_BINARY");
    expect(result.status).toBe(0);
  });

  it("strips only its own directory, keeping the rest of PATH intact", () => {
    // The damaging failure is a strip that keeps the last entry and discards
    // the others: the harness would still resolve, and would resolve against a
    // PATH with no System32 in it. The decoy dirs exist to be lost, so this
    // fails when they do.
    const { testPath, keepDir, probeScript, read } = stageShim("claude");
    spawnShim("claude", testPath, {}, [probeScript]);

    const handedDown = read("path");
    // The shim's own directory is gone, so the wrapper cannot recurse.
    expect(handedDown).not.toContain("shims");
    // Everything else survived, in order, with the real binary still findable.
    expect(handedDown).toContain(keepDir);
    expect(handedDown).toContain("decoy-a");
    expect(handedDown).toContain("decoy-b");
  });

  it("passes a key-only Codex terminal through untouched", () => {
    const { testPath, probeScript, read } = stageShim("codex");
    spawnShim("codex", testPath, { OPENAI_API_KEY: "sk-mine" }, [probeScript]);
    // The endpoint must not be repointed at the gateway.
    expect(read("base")).toBe("");
  });
});
