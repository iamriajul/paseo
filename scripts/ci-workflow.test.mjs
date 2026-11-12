import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_RELEASE_TARGETS,
  RELEASE_TARGETS,
  formatGithubOutput,
  resolveReleaseTargets,
} from "./release-targets.mjs";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);
const desktopReleasePath = new URL(".github/workflows/desktop-release.yml", repoRoot);

const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  [
    "server-tests-macos",
    { name: "server-tests (macos-latest, file observation)", contract: "server" },
  ],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["playwright-1", { name: "playwright (shard 1/8)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/8)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/8)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/8)", contract: "browser" }],
  ["playwright-5", { name: "playwright (shard 5/8)", contract: "browser" }],
  ["playwright-6", { name: "playwright (shard 6/8)", contract: "browser" }],
  ["playwright-7", { name: "playwright (shard 7/8)", contract: "browser" }],
  ["playwright-8", { name: "playwright (shard 8/8)", contract: "browser" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [
    ciWorkflowPath,
    new URL(".github/workflows/desktop-packages.yml", repoRoot),
  ]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
    "a newer push to any ref, main included, cancels the superseded run",
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.match(changes, /scripts\/lockfile-registry\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("ordinary CI keeps app tests without prebuilding Android modules", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const app = jobBlocks(source).get("app-tests").join("\n");
  assert.match(app, /npm run build:app-deps/);
  assert.match(app, /npm run test --workspace=@getpaseo\/app/);
  assert.doesNotMatch(source, /test:android|expo prebuild|gradlew|actions\/setup-java/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/**/*.electron.{ts,tsx}",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("stable iOS releases upload once and distribute to external testers before App Store review", () => {
  const source = readFileSync(
    new URL("packages/app/.eas/workflows/release-mobile.yml", repoRoot),
    "utf8",
  );
  const jobs = jobBlocks(source);
  const uploads = [...jobs.entries()].filter(
    ([, lines]) =>
      lines.some((line) => /^    type: (submit|testflight)$/.test(line)) &&
      lines.some((line) => line.includes("needs.build_ios.outputs.build_id")),
  );
  assert.equal(uploads.length, 1, "the iOS binary must be uploaded exactly once");
  const [distributionId, distributionLines] = uploads[0];
  const distribution = distributionLines.join("\n");
  assert.match(distribution, /^    type: testflight$/m);
  assert.match(distribution, /external_groups:\s*\n\s+- Paseo Beta/);
  assert.match(distribution, /^      submit_beta_review: true$/m);

  const review = jobs.get("submit_ios_for_review").join("\n");
  assert.match(review, new RegExp(`needs: \\[build_ios, ${distributionId}\\]`));
  assert.match(review, /APP_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_version \}\}"/);
  assert.match(
    review,
    /APP_BUILD_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_build_version \}\}"/,
  );
  assert.match(review, /bundle exec fastlane ios submit_review/);
});

test("eight Playwright shards share two-worker coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  // Fork adds fork-decisions.
  assert.equal(jobs.size, 22);
  for (let shard = 1; shard <= 8; shard++) {
    const job = jobs.get(`playwright-${shard}`).join("\n");
    assert.match(job, new RegExp(`PLAYWRIGHT_SHARD: "${shard}/8"`));
    assert.match(job, new RegExp(`PLAYWRIGHT_ARTIFACT: "${shard}"`));
    assert.match(
      job,
      shard === 1 ? /steps: &playwright_test_steps/ : /steps: \*playwright_test_steps/,
    );
  }
  const shared = jobs.get("playwright-1").join("\n");
  assert.match(shared, /E2E_WORKERS: "2"/);
  const weights = /PWTEST_SHARD_WEIGHTS: "([\d:]+)"/.exec(shared)[1].split(":").map(Number);
  assert.equal(weights.length, 8);
  assert.ok(weights.every((weight) => weight > 0));
  assert.match(shared, /npm run test:e2e --workspace=@getpaseo\/app -- --shard=/);

  // No fan-in result job: a gate needs its own runner and under contention it
  // queued 8m08s behind the last shard. Required checks name the shards directly.
  assert.equal(jobs.has("playwright"), false);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/paseo-plugin.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@getpaseo/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@getpaseo/plugin",
      "npm run test --workspace=@getpaseo/protocol",
      "npm run test --workspace=@getpaseo/client",
      "npm run test --workspace=@getpaseo/highlight",
      "npm run typecheck:examples --workspace=@getpaseo/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@getpaseo\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@getpaseo\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(job, /^    needs: changes$/m, "both phases become eligible independently");
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@getpaseo\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/agent/providers/omp/history.e2e.test.ts src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses|replays selected OMP history"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  assert.doesNotMatch(serverConfig, /maxWorkers/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      cancelled: () => cancelled,
    });
  }
  const unitCondition = condition(windows);
  const integrationCondition = condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    assert.equal(selected(unitCondition, outputs), units);
    assert.equal(selected(integrationCondition, outputs), integrations);
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    assert.equal(selected(unitCondition, outputs, true), false);
    assert.equal(selected(integrationCondition, outputs, true), false);
  }
});

test("macOS release retries only transient stapling failures without rebuilding the signed app", async (t) => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const wrapper = workflow
    .match(/<<'STAPLER'\n([\s\S]*?)\n          STAPLER/)[1]
    .replace(/^          /gm, "");
  const networkError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const cases = [
    {
      name: "success",
      outcomes: [0],
      output: "stapled",
      command: "stapler",
      expected: 0,
      attempts: 1,
    },
    {
      name: "transient then success",
      outcomes: [68, 0],
      output: networkError,
      command: "stapler",
      expected: 0,
      attempts: 2,
    },
    {
      name: "exhausted network retries",
      outcomes: [68, 68, 68, 68, 0],
      output: networkError,
      command: "stapler",
      expected: 68,
      attempts: 4,
    },
    {
      name: "non-network staple error",
      outcomes: [68, 0],
      output: "ticket not found",
      command: "stapler",
      expected: 68,
      attempts: 1,
    },
    {
      name: "different exit code",
      outcomes: [1, 0],
      output: networkError,
      command: "stapler",
      expected: 1,
      attempts: 1,
    },
    {
      name: "notary submission is not retried",
      outcomes: [68, 0],
      output: networkError,
      command: "notarytool",
      expected: 68,
      attempts: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "stapler-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(
          statePath,
          JSON.stringify({ outcomes: scenario.outcomes, output: scenario.output, calls: [] }),
        );
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STAPLER_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const code = state.outcomes.shift();
fs.writeFileSync(process.env.STAPLER_STATE, JSON.stringify(state));
console.log(state.output);
process.exit(code);
`,
          { mode: 0o755 },
        );
        const args = [scenario.command, "staple", "-v", "Paseo signed.app"];
        const result = spawnSync("bash", [wrapperPath, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PASEO_REAL_XCRUN: realXcrun,
            STAPLER_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(
          state.calls,
          Array.from({ length: scenario.attempts }, () => args),
        );
        assert.match(result.stdout, /stapled|network connection was lost|ticket not found/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// GitHub retires macOS 14 on 2026-11-02; brownouts already reject these jobs.
test("workflows avoid retired macOS 14 runners", () => {
  for (const path of filesUnder(".github/workflows", (candidate) => /\.ya?ml$/.test(candidate))) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /macos-14(?:-large|-xlarge)?\b/,
      path,
    );
  }
});

test("macOS jobs use latest runners while preserving release architectures", () => {
  for (const [workflow, jobId] of [
    [ciWorkflowPath, "server-tests-macos"],
    [nixWorkflowPath, "build-desktop-darwin"],
  ]) {
    assert.match(
      jobBlocks(readFileSync(workflow, "utf8")).get(jobId).join("\n"),
      /^    runs-on: macos-latest$/m,
    );
  }
  const { include } = releaseTargetOutputs(RELEASE_TARGETS)["macos-matrix"];
  assert.deepEqual(
    include.map(({ runner, electron_arch }) => [runner, electron_arch]),
    [
      ["macos-latest", "arm64"],
      // GitHub has no standard macos-latest-intel alias; use the newest Intel image.
      ["macos-26-intel", "x64"],
    ],
  );
});

test("macOS signing repair keeps certificate and keychain passwords separate", () => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const match = workflow.match(/<<'KEYCHAIN_FIX'\n([\s\S]*?)\n          KEYCHAIN_FIX/);
  assert.ok(match, "the release workflow repairs the pinned signing tool");
  const script = match[1].replace(/^          /gm, "");
  const original = [
    "return await importCerts(keychainFile, certPaths, cscPasswords);",
    "async function importCerts(keychainFile, paths, keyPasswords) {",
    '["import", paths[i], "-P", password]',
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
    "}",
  ].join("\n");
  const directory = mkdtempSync(join(tmpdir(), "signing-repair-"));
  try {
    const packageDirectory = join(directory, "node_modules/app-builder-lib");
    mkdirSync(join(packageDirectory, "out/codeSign"), { recursive: true });
    const manifest = join(packageDirectory, "package.json");
    const sourcePath = join(packageDirectory, "out/codeSign/macCodeSign.js");
    for (const [version, source, succeeds] of [
      ["26.8.1", original, true],
      ["26.8.1", original.replace("cscPasswords);", "differentArguments);"), false],
      ["26.18.0", original, false],
    ]) {
      writeFileSync(manifest, JSON.stringify({ name: "app-builder-lib", version }));
      writeFileSync(sourcePath, source);
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: directory,
        encoding: "utf8",
      });
      const actual = readFileSync(sourcePath, "utf8");
      if (succeeds) {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(
          actual.includes("importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)"),
        );
        assert.ok(
          actual.includes("importCerts(keychainFile, paths, keyPasswords, keychainPassword)"),
        );
        assert.ok(actual.includes('["import", paths[i], "-P", password]'));
        assert.ok(actual.includes('"-k", keychainPassword, keychainFile]'));
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(actual, source, "unexpected tool inputs must fail without a partial write");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function releaseTargetOutputs(enabled) {
  return Object.fromEntries(
    formatGithubOutput(enabled)
      .trim()
      .split("\n")
      .map((line) => {
        const [key, ...rest] = line.split("=");
        const value = rest.join("=");
        return [key, key === "macos-matrix" ? JSON.parse(value) : value];
      }),
  );
}

test("release tags build only macOS arm64, the Android APK and the npm packages unless RELEASE_TARGETS says otherwise", () => {
  assert.deepEqual(DEFAULT_RELEASE_TARGETS, ["desktop-macos-arm64", "android-apk", "npm"]);
  for (const variable of [undefined, "", "  "]) {
    assert.deepEqual(resolveReleaseTargets({ variable }), DEFAULT_RELEASE_TARGETS);
  }
  const outputs = releaseTargetOutputs(resolveReleaseTargets({}));
  assert.equal(outputs["desktop-macos-arm64"], "true");
  assert.equal(outputs["android-apk"], "true");
  assert.equal(outputs.npm, "true");
  for (const target of RELEASE_TARGETS.filter((t) => !DEFAULT_RELEASE_TARGETS.includes(t))) {
    assert.equal(outputs[target], "false", target);
  }
  assert.equal(outputs["desktop-macos"], "true");
  assert.deepEqual(outputs["macos-matrix"].include, [
    { runner: "macos-latest", electron_arch: "arm64", node_heap_mb: 4096 },
  ]);

  assert.deepEqual(resolveReleaseTargets({ variable: "docker, npm android-apk" }), [
    "android-apk",
    "docker",
    "npm",
  ]);
  assert.deepEqual(resolveReleaseTargets({ variable: "all" }), RELEASE_TARGETS);
  assert.throws(() => resolveReleaseTargets({ variable: "desktop-mac" }), /desktop-mac/);
  assert.equal(releaseTargetOutputs(["android-apk"])["desktop-macos"], "false");
  assert.deepEqual(releaseTargetOutputs(["android-apk"])["macos-matrix"], { include: [] });
});

test("a dispatch input or an explicit scope overrides RELEASE_TARGETS", () => {
  const variable = "desktop-macos-arm64,android-apk";
  assert.deepEqual(resolveReleaseTargets({ input: "desktop-windows", variable }), [
    "desktop-windows",
  ]);
  // Platform tags, the desktop `platform` input, and single-target dispatches name their targets.
  assert.deepEqual(resolveReleaseTargets({ variable, scope: "macos" }), [
    "desktop-macos-arm64",
    "desktop-macos-x64",
  ]);
  assert.deepEqual(resolveReleaseTargets({ variable, scope: "docker" }), ["docker"]);
  assert.deepEqual(resolveReleaseTargets({ variable, scope: "desktop" }).length, 4);
  // The input narrows within an explicit scope.
  assert.deepEqual(resolveReleaseTargets({ input: "desktop-macos-x64,docker", scope: "macos" }), [
    "desktop-macos-x64",
  ]);
  assert.throws(() => resolveReleaseTargets({ scope: "ios" }), /ios/);
});

test("every tag-triggered build job waits on its release target before a runner starts", () => {
  const gated = [
    [
      "desktop-release.yml",
      "publish-macos",
      "needs.release-targets.outputs.desktop-macos == 'true'",
    ],
    [
      "desktop-release.yml",
      "publish-linux",
      "needs.release-targets.outputs.desktop-linux == 'true'",
    ],
    [
      "desktop-release.yml",
      "publish-windows",
      "needs.release-targets.outputs.desktop-windows == 'true'",
    ],
    [
      "android-apk-release.yml",
      "ensure-release",
      "needs.release-targets.outputs.android-apk == 'true'",
    ],
    [
      "android-apk-release.yml",
      "publish-fork-android-apk",
      "needs.release-targets.outputs.android-apk == 'true'",
    ],
    [
      "android-apk-release.yml",
      "publish-android-apk-eas",
      "needs.release-targets.outputs.android-apk == 'true'",
    ],
    [
      "android-browser-native.yml",
      "android-browser-native",
      "needs.release-targets.outputs.android-browser-native == 'true'",
    ],
    [
      "npm-global-install-release.yml",
      "package-npm-global-install",
      "needs.release-targets.outputs.npm == 'true'",
    ],
    ["docker.yml", "build", "needs.setup.outputs.enabled == 'true'"],
    ["docker.yml", "publish", "needs.setup.outputs.enabled == 'true'"],
  ];
  for (const [file, jobId, condition] of gated) {
    const source = readFileSync(new URL(`.github/workflows/${file}`, repoRoot), "utf8");
    const job = jobBlocks(source).get(jobId)?.join("\n");
    assert.ok(job, `${file} has job ${jobId}`);
    const ifLine = job.match(/^    if: (.*)$/m)?.[1] ?? "";
    assert.ok(ifLine.includes(condition), `${file} ${jobId} is gated by ${condition}`);
  }
  for (const file of [
    "desktop-release.yml",
    "android-apk-release.yml",
    "android-browser-native.yml",
    "npm-global-install-release.yml",
    "docker.yml",
  ]) {
    const source = readFileSync(new URL(`.github/workflows/${file}`, repoRoot), "utf8");
    assert.match(source, /RELEASE_TARGETS_VARIABLE: \$\{\{ vars\.RELEASE_TARGETS \}\}/, file);
    assert.match(source, /run: node scripts\/release-targets\.mjs >> "\$GITHUB_OUTPUT"/, file);
  }
  const macos = jobBlocks(readFileSync(desktopReleasePath, "utf8")).get("publish-macos").join("\n");
  assert.match(
    macos,
    /matrix: \$\{\{ fromJSON\(needs\.release-targets\.outputs\.macos-matrix\) \}\}/,
  );
});

// Runs the real finalize step with a stub `gh`, so the draft-release decision is tested, not grepped.
const finalizeDraft = {
  id: 1,
  tag_name: "v1.2.3",
  name: "Paseo v1.2.3",
  draft: true,
  html_url: "https://github.com/owner/paseo/releases/tag/untagged-1",
  assets: [],
};

// `publishMidStep` models npm Global Install Release publishing the draft right after the
// step's first lookup: from then on the draft's `untagged-…` slug 404s, like on GitHub.
function runFinalize({
  enabled,
  results,
  manifests,
  releases = [finalizeDraft],
  publishMidStep = false,
}) {
  const workflow = readFileSync(desktopReleasePath, "utf8");
  const finalize = jobBlocks(workflow).get("finalize-rollout").join("\n");
  const step = finalize.match(
    /- name: Assemble manifests and publish release\n[\s\S]*?\n        run: \|\n([\s\S]*?)(?=\n      - name:|$)/,
  );
  assert.ok(step, "finalize-rollout assembles manifests");
  const values = {
    "github.repository": "owner/paseo",
    "needs.publish-macos.result": results.macos,
    "needs.publish-linux.result": results.linux,
    "needs.publish-windows.result": results.windows,
  };
  const script = step[1].replace(/^          /gm, "").replace(/\$\{\{ ([^}]+?) \}\}/g, (_, key) => {
    assert.ok(key in values, `finalize uses unknown expression ${key}`);
    return values[key];
  });
  const directory = mkdtempSync(join(tmpdir(), "release-finalize-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const log = join(directory, "gh.log");
    const state = join(directory, "releases.json");
    writeFileSync(state, JSON.stringify({ releases, lists: 0 }));
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (state.published && args.some((arg) => arg.includes("untagged-1"))) {
  process.stderr.write("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "repos/owner/paseo/releases?per_page=100") {
  process.stdout.write(JSON.stringify(state.releases));
  state.lists += 1;
  if (${publishMidStep} && state.lists === 1) {
    state.published = true;
    state.releases[0] = { ...state.releases[0], draft: false,
      html_url: "https://github.com/owner/paseo/releases/tag/v1.2.3" };
  }
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
}
`,
      { mode: 0o755 },
    );
    const work = join(directory, "work");
    mkdirSync(work);
    cpSync(new URL("scripts", repoRoot), join(work, "scripts"), { recursive: true });
    // The `changes` job runs this suite without installing dependencies, so the scripts
    // that need js-yaml are stubbed: the merge stub records which arch manifests it got,
    // in order. merge-mac-manifest.test.mjs and validate-desktop-manifests.test.mjs cover
    // the real YAML handling.
    writeFileSync(
      join(work, "scripts", "merge-mac-manifest.mjs"),
      'import fs from "node:fs";\nconst [, , out, ...inputs] = process.argv;\nfs.writeFileSync(out, inputs.join("\\n") + "\\n");\n',
    );
    for (const name of ["stamp-rollout.mjs", "validate-desktop-manifests.mjs"]) {
      writeFileSync(join(work, "scripts", name), "");
    }
    for (const [arch, files] of Object.entries(manifests)) {
      const dir = join(work, "release-manifests", `mac-manifest-${arch}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "latest-mac.yml"),
        `version: 1.2.3\nfiles:\n${files.map((url) => `  - url: ${url}\n    sha512: x\n`).join("")}path: ${files[0]}\nsha512: x\n`,
      );
    }
    const result = spawnSync("bash", ["-c", script], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "test",
        RELEASE_CHANNEL: "latest",
        RELEASE_TAG: "v1.2.3",
        ROLLOUT_HOURS: "0",
        IS_PRERELEASE: "false",
        MACOS_ENABLED: String(enabled.includes("macos")),
        LINUX_ENABLED: String(enabled.includes("linux")),
        WINDOWS_ENABLED: String(enabled.includes("windows")),
      },
      timeout: 30000,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const finalManifest = join(work, "release-manifests", "final", "latest-mac.yml");
    let mac = null;
    try {
      mac = readFileSync(finalManifest, "utf8");
    } catch {}
    return { status: result.status, output: result.stdout + result.stderr, calls, mac };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Uploads go to the release id, never a draft's slug, which stops resolving once published.
const manifestUpload =
  /^api --method POST https:\/\/uploads\.github\.com\/repos\/owner\/paseo\/releases\/1\/assets\?name=latest-mac\.yml .*--input .*final\/latest-mac\.yml$/;

const published = (calls) =>
  calls.some((call) =>
    /^api --method PATCH repos\/owner\/paseo\/releases\/\d+ .*draft=false/.test(call),
  );

test("finalize publishes an arm64-only macOS release with its updater manifest", () => {
  const run = runFinalize({
    enabled: ["macos"],
    results: { macos: "success", linux: "skipped", windows: "skipped" },
    manifests: { arm64: ["Paseo-1.2.3-arm64-mac.zip"] },
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.mac, "mac-manifest-arm64/latest-mac.yml\n");
  assert.ok(
    run.calls.some((call) => manifestUpload.test(call)),
    run.calls.join("\n"),
  );
  assert.ok(published(run.calls), run.calls.join("\n"));
});

test("finalize deletes an empty duplicate release before it publishes the draft", () => {
  // v0.15.913: three workflows each created a release for the tag, and publishing the
  // draft failed with "Release.tag_name already exists".
  const run = runFinalize({
    enabled: ["macos"],
    results: { macos: "success", linux: "skipped", windows: "skipped" },
    manifests: { arm64: ["Paseo-1.2.3-arm64-mac.zip"] },
    releases: [
      {
        ...finalizeDraft,
        id: 2,
        html_url: "https://github.com/owner/paseo/releases/tag/untagged-2",
      },
      finalizeDraft,
    ],
  });
  assert.equal(run.status, 0, run.output);
  const deleted = run.calls.findIndex(
    (call) => call === "api --method DELETE repos/owner/paseo/releases/2",
  );
  assert.ok(deleted >= 0, run.calls.join("\n"));
  const publish = run.calls.findIndex((call) =>
    call.startsWith("api --method PATCH repos/owner/paseo/releases/1 "),
  );
  assert.ok(deleted < publish, run.calls.join("\n"));
});

test("finalize still uploads the manifest when npm publishes the draft during the step", () => {
  const run = runFinalize({
    enabled: ["macos"],
    results: { macos: "success", linux: "skipped", windows: "skipped" },
    manifests: { arm64: ["Paseo-1.2.3-arm64-mac.zip"] },
    releases: [{ ...finalizeDraft, assets: [{ id: 50, name: "latest-mac.yml" }] }],
    publishMidStep: true,
  });
  assert.equal(run.status, 0, run.output);
  assert.ok(
    run.calls.includes(
      "api -H Accept: application/octet-stream repos/owner/paseo/releases/assets/50",
    ),
    run.calls.join("\n"),
  );
  assert.ok(run.calls.includes("api --method DELETE repos/owner/paseo/releases/assets/50"));
  assert.ok(
    run.calls.some((call) => manifestUpload.test(call)),
    run.calls.join("\n"),
  );
  assert.ok(!run.calls.some((call) => call.includes("untagged-")), run.calls.join("\n"));
  assert.ok(!published(run.calls), "npm already published it");
});

test("finalize accepts a release npm already published: uploads the manifest, skips the publish", () => {
  const run = runFinalize({
    enabled: ["macos"],
    results: { macos: "success", linux: "skipped", windows: "skipped" },
    manifests: { arm64: ["Paseo-1.2.3-arm64-mac.zip"] },
    releases: [
      {
        ...finalizeDraft,
        draft: false,
        html_url: "https://github.com/owner/paseo/releases/tag/v1.2.3",
        assets: [{ name: "getpaseo-cli-1.2.3.tgz" }],
      },
      {
        ...finalizeDraft,
        id: 2,
        html_url: "https://github.com/owner/paseo/releases/tag/untagged-2",
      },
    ],
  });
  assert.equal(run.status, 0, run.output);
  assert.ok(
    run.calls.some((call) => manifestUpload.test(call)),
    run.calls.join("\n"),
  );
  assert.ok(
    run.calls.includes("api --method DELETE repos/owner/paseo/releases/2"),
    run.calls.join("\n"),
  );
  assert.ok(!published(run.calls), run.calls.join("\n"));
});

// npm publishes the release before the desktop builds finish, so the updater manifest has to
// be the last desktop file a published release gains: updaters report no update until it exists.
test("only finalize-rollout uploads updater manifests, after every desktop build", () => {
  const jobs = jobBlocks(readFileSync(desktopReleasePath, "utf8"));
  for (const jobId of ["publish-macos", "publish-linux", "publish-windows"]) {
    const job = jobs.get(jobId).join("\n");
    // upload-release-assets.mjs skips *.yml; the manifest travels as an artifact instead.
    assert.match(
      job,
      /node scripts\/upload-release-assets\.mjs "\$RELEASE_TAG" "\$release_dir"/,
      jobId,
    );
    assert.doesNotMatch(job, /gh release upload/, jobId);
  }
  const finalize = jobs.get("finalize-rollout").join("\n");
  assert.match(finalize, /needs: \[[^\]]*publish-macos[^\]]*\]/);
  const npm = jobBlocks(
    readFileSync(new URL(".github/workflows/npm-global-install-release.yml", repoRoot), "utf8"),
  )
    .get("package-npm-global-install")
    .join("\n");
  const upload = npm.indexOf(
    'node scripts/upload-release-assets.mjs "$RELEASE_TAG" "$NPM_RELEASE_ASSETS"',
  );
  assert.ok(upload > 0, "npm uploads its tarballs to the resolved release");
  assert.ok(
    npm.indexOf('publish_args=(--repo "${{ github.repository }}" --tag "$RELEASE_TAG" --publish)') >
      upload,
    "npm publishes the release after its tarballs are up",
  );
  assert.doesNotMatch(
    npm.replace(/^\s*#.*$/gm, ""),
    /\.yml/,
    "npm never uploads an updater manifest",
  );
});

test("every release workflow creates the release through the shared script, as a draft", () => {
  const creators = [
    ["desktop-release.yml", "create-release"],
    ["android-apk-release.yml", "ensure-release"],
    ["npm-global-install-release.yml", "package-npm-global-install"],
  ];
  for (const [file, jobId] of creators) {
    const job = jobBlocks(readFileSync(new URL(`.github/workflows/${file}`, repoRoot), "utf8"))
      .get(jobId)
      .join("\n");
    assert.match(
      job,
      /node scripts\/github-release\.mjs "\$\{ensure_args\[@\]\}"/,
      `${file} ${jobId}`,
    );
  }
  for (const file of [
    "desktop-release.yml",
    "android-apk-release.yml",
    "npm-global-install-release.yml",
    "release-notes-sync.yml",
  ]) {
    const source = readFileSync(new URL(`.github/workflows/${file}`, repoRoot), "utf8");
    assert.doesNotMatch(source, /release create/, `${file} creates a release outside the script`);
    // `gh release upload <tag>` picks an arbitrary release when duplicates exist, and a lookup
    // captured as a draft's slug 404s once the draft is published.
    assert.doesNotMatch(source, /release upload "\$RELEASE_TAG"/, `${file} uploads by tag`);
    if (file !== "android-apk-release.yml") {
      assert.doesNotMatch(source, /gh release (upload|download|delete-asset|view)/, file);
    }
  }
  const fork = jobBlocks(
    readFileSync(new URL(".github/workflows/android-apk-release.yml", repoRoot), "utf8"),
  )
    .get("publish-fork-android-apk")
    .join("\n");
  assert.match(fork, /needs: \[release-targets, ensure-release\]/);
  assert.match(fork, /node scripts\/upload-release-assets\.mjs "\$RELEASE_TAG" "\$upload_dir"/);
  assert.doesNotMatch(fork, /gh release upload/);
});

test("finalize merges both macOS arches when both are enabled", () => {
  const run = runFinalize({
    enabled: ["macos"],
    results: { macos: "success", linux: "skipped", windows: "skipped" },
    manifests: { arm64: ["Paseo-arm64.zip"], x64: ["Paseo-x64.zip"] },
  });
  assert.equal(run.status, 0, run.output);
  // arm64 first, so its top-level fields win in the merged manifest.
  assert.equal(run.mac, "mac-manifest-arm64/latest-mac.yml\nmac-manifest-x64/latest-mac.yml\n");
});

test("finalize publishes a release with no desktop targets and does not publish when an enabled target failed", () => {
  const none = runFinalize({
    enabled: [],
    results: { macos: "skipped", linux: "skipped", windows: "skipped" },
    manifests: {},
  });
  assert.equal(none.status, 0, none.output);
  assert.ok(!none.calls.some((call) => call.includes("uploads.github.com")), none.calls.join("\n"));
  assert.ok(published(none.calls), none.calls.join("\n"));

  const failed = runFinalize({
    enabled: ["macos"],
    results: { macos: "failure", linux: "skipped", windows: "skipped" },
    manifests: {},
  });
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /::error::/);
  assert.ok(!published(failed.calls));

  const missing = runFinalize({
    enabled: ["macos", "linux"],
    results: { macos: "success", linux: "skipped", windows: "skipped" },
    manifests: { arm64: ["Paseo-arm64.zip"] },
  });
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /Missing updater manifests: latest-linux\.yml/);
  assert.ok(!published(missing.calls));
});
