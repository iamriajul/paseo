import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load package-local .env.test first for integration/E2E credentials, then repo-root .env fallback.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.resolve(serverRoot, ".env.test"), override: true });
dotenv.config({ path: path.resolve(serverRoot, "../.env") });

process.env.PASEO_SUPERVISED = "0";
process.env.GIT_TERMINAL_PROMPT = "0";

// Anything that persists under $PASEO_HOME (provider caches, ui state, drafts) must
// land in a temp dir during tests. Without this a cache-writing test can read or
// overwrite the developer's real cache home, and a stale file there breaks unrelated
// suites.
const testPaseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-test-home-"));
process.env.PASEO_HOME = testPaseoHome;
// Gateway catalog caching is exercised explicitly by its own tests; everywhere else
// it would only write files into a cache home. The repo-root vitest config has no
// setup files, so this flag — not a redirected $PASEO_HOME — is what actually
// guarantees no suite writes a gateway cache outside its temp dir.
process.env.PASEO_DISABLE_GATEWAY_CACHE = "1";
process.on("exit", () => {
  rmSync(testPaseoHome, { recursive: true, force: true });
});
process.env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
process.env.SSH_ASKPASS = "/usr/bin/false";
process.env.SSH_ASKPASS_REQUIRE = "force";
process.env.DISPLAY = process.env.DISPLAY ?? "1";
