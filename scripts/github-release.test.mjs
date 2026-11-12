import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensureGitHubRelease, getGitHubRelease, main } from "./github-release.mjs";

const REPO = "owner/paseo";
const TAG = "v1.2.3";
const scriptPath = fileURLToPath(new URL("./github-release.mjs", import.meta.url));

function release(id, { draft = true, assets = 0, tag = TAG } = {}) {
  return {
    id,
    draft,
    name: `Paseo ${TAG}`,
    tag_name: tag,
    html_url: `https://github.com/${REPO}/releases/tag/${draft ? `untagged-${id}` : TAG}`,
    assets: Array.from({ length: assets }, (_, index) => ({ name: `asset-${index}` })),
  };
}

// A GitHub releases API that, like the real one, lets any number of releases share a tag.
function fakeGitHub(initial = []) {
  const state = { releases: [...initial], nextId: 100, calls: [] };
  const execFileSync = (command, args) => {
    assert.equal(command, "gh");
    state.calls.push(args.join(" "));
    if (args[0] === "api" && args[1] === `repos/${REPO}/releases?per_page=100`) {
      return JSON.stringify([...state.releases].sort((a, b) => b.id - a.id));
    }
    if (args[0] === "api" && args[1] === `repos/${REPO}/git/ref/tags/${TAG}`) {
      return "{}";
    }
    if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
      const field = (name) =>
        args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const created = release((state.nextId += 1), { draft: field("draft") === "true" });
      created.tag_name = field("tag_name");
      created.prerelease = field("prerelease") === "true";
      created.target_commitish = field("target_commitish");
      state.releases.push(created);
      return JSON.stringify(created);
    }
    if (args[0] === "api" && args[1] === "--method" && args[2] === "PATCH") {
      const id = Number(args[3].split("/").at(-1));
      const target = state.releases.find((candidate) => candidate.id === id);
      if (args.includes("draft=false")) {
        if (state.releases.some((other) => other.id !== id && other.draft === false)) {
          throw new Error("HTTP 422: Release.tag_name already exists");
        }
        target.draft = false;
        target.tag_name = TAG;
        target.html_url = `https://github.com/${REPO}/releases/tag/${TAG}`;
      }
      return "{}";
    }
    if (args[0] === "api" && args[1] === "--method" && args[2] === "DELETE") {
      const id = Number(args[3].split("/").at(-1));
      state.releases = state.releases.filter((candidate) => candidate.id !== id);
      return "";
    }
    throw new Error(`Unexpected gh call: gh ${args.join(" ")}`);
  };
  return { state, execFileSync };
}

const noSleep = () => {};

test("creates a missing release as a draft with the requested flags", () => {
  const github = fakeGitHub();
  const created = ensureGitHubRelease(
    { repo: REPO, tag: TAG, prerelease: true, target: "main" },
    { execFileSync: github.execFileSync, sleep: noSleep },
  );
  assert.equal(github.state.releases.length, 1);
  assert.equal(created.id, github.state.releases[0].id);
  assert.equal(created.draft, true);
  assert.equal(created.prerelease, true);
  assert.equal(created.target_commitish, "main");
});

test("reuses an existing draft instead of creating a second release", () => {
  const github = fakeGitHub([release(7)]);
  const lookup = main(["--repo", REPO, "--tag", TAG, "--ensure"], {
    execFileSync: github.execFileSync,
    sleep: noSleep,
  });
  assert.equal(lookup, "untagged-7");
  assert.deepEqual(
    github.state.releases.map((candidate) => candidate.id),
    [7],
  );
  assert.equal(
    github.state.calls.some((call) => call.includes("--method POST")),
    false,
  );
});

test("concurrent creators converge on the oldest draft and delete the empty duplicates", () => {
  // Three workflows list at the same moment, each sees nothing, each creates.
  const github = fakeGitHub();
  const creators = [0, 1, 2];
  for (const _creator of creators) {
    assert.equal(getGitHubRelease(REPO, TAG, github.execFileSync), null);
  }
  for (const _creator of creators) {
    github.execFileSync("gh", [
      "api",
      "--method",
      "POST",
      `repos/${REPO}/releases`,
      "-f",
      `tag_name=${TAG}`,
      "-F",
      "draft=true",
    ]);
  }
  assert.equal(github.state.releases.length, 3);
  const oldest = Math.min(...github.state.releases.map((candidate) => candidate.id));

  // Each creator's settle-then-dedupe pass, which `ensureGitHubRelease` runs after its create.
  const lookups = creators.map(() =>
    main(["--repo", REPO, "--tag", TAG, "--cleanup-duplicates"], {
      execFileSync: github.execFileSync,
      sleep: noSleep,
    }),
  );
  assert.deepEqual(lookups, [`untagged-${oldest}`, `untagged-${oldest}`, `untagged-${oldest}`]);
  assert.deepEqual(
    github.state.releases.map((candidate) => candidate.id),
    [oldest],
  );
});

test("a creator that missed a concurrent create still resolves the canonical release later", () => {
  const github = fakeGitHub();
  ensureGitHubRelease(
    { repo: REPO, tag: TAG },
    { execFileSync: github.execFileSync, sleep: noSleep },
  );
  const first = github.state.releases[0].id;
  // A second creator listed before the first create was visible, so it creates too, and its
  // own settle pass still sees the old state.
  github.execFileSync("gh", [
    "api",
    "--method",
    "POST",
    `repos/${REPO}/releases`,
    "-f",
    `tag_name=${TAG}`,
    "-F",
    "draft=true",
  ]);
  assert.equal(github.state.releases.length, 2);
  // Every uploader resolves by the same rule, so the build lands on the first release.
  assert.equal(getGitHubRelease(REPO, TAG, github.execFileSync).id, first);
  // Desktop finalize-rollout's cleanup removes the leftover before publishing.
  main(["--repo", REPO, "--tag", TAG, "--cleanup-duplicates"], {
    execFileSync: github.execFileSync,
    sleep: noSleep,
  });
  assert.deepEqual(
    github.state.releases.map((candidate) => candidate.id),
    [first],
  );
});

test("a duplicate that holds assets is never deleted", () => {
  // The state v0.15.913 was left in: an empty published release beside the draft that held
  // the build. No workflow creates a published release any more, so this cannot recur; the
  // cleanup still must not delete the build.
  const github = fakeGitHub([release(5, { assets: 13 }), release(6, { draft: false })]);
  const lookup = main(["--repo", REPO, "--tag", TAG, "--cleanup-duplicates"], {
    execFileSync: github.execFileSync,
    sleep: noSleep,
  });
  assert.equal(lookup, TAG);
  assert.deepEqual(github.state.releases.map((candidate) => candidate.id).sort(), [5, 6]);
});

test("a published release wins over drafts, and empty drafts are removed", () => {
  const github = fakeGitHub([release(3), release(4, { draft: false, assets: 13 }), release(9)]);
  const lookup = main(["--repo", REPO, "--tag", TAG, "--cleanup-duplicates"], {
    execFileSync: github.execFileSync,
    sleep: noSleep,
  });
  assert.equal(lookup, TAG);
  assert.deepEqual(
    github.state.releases.map((candidate) => candidate.id),
    [4],
  );
});

test("publish turns the canonical draft into the published release after removing duplicates", () => {
  const github = fakeGitHub([release(7, { assets: 3 }), release(8)]);
  const lookup = main(["--repo", REPO, "--tag", TAG, "--publish"], {
    execFileSync: github.execFileSync,
    sleep: noSleep,
  });
  assert.equal(lookup, TAG);
  assert.deepEqual(
    github.state.releases.map((candidate) => [candidate.id, candidate.draft]),
    [[7, false]],
  );
  const deleteCall = github.state.calls.findIndex((call) => call.includes("--method DELETE"));
  const patchCall = github.state.calls.findIndex((call) => call.includes("--method PATCH"));
  assert.ok(deleteCall >= 0 && deleteCall < patchCall, github.state.calls.join("\n"));
});

test("publishing an already published release changes nothing", () => {
  // npm publishes first; finalize-rollout's later publish must succeed without a second edit.
  const github = fakeGitHub([release(7, { draft: false, assets: 3 })]);
  for (let run = 0; run < 2; run += 1) {
    main(["--repo", REPO, "--tag", TAG, "--publish"], {
      execFileSync: github.execFileSync,
      sleep: noSleep,
    });
  }
  assert.equal(
    github.state.calls.some((call) => call.includes("--method PATCH")),
    false,
  );
  assert.equal(github.state.releases[0].draft, false);
});

test("publish fails when the tag has no release", () => {
  const github = fakeGitHub();
  assert.throws(
    () =>
      main(["--repo", REPO, "--tag", TAG, "--publish"], {
        execFileSync: github.execFileSync,
        sleep: noSleep,
      }),
    /No release exists for v1\.2\.3/,
  );
});

test("releases for other tags are never touched", () => {
  const github = fakeGitHub([
    release(1, { tag: "v1.2.2", draft: false }),
    { ...release(2, { tag: "untagged-2" }), name: "Paseo v1.2.2" },
    release(3),
  ]);
  main(["--repo", REPO, "--tag", TAG, "--cleanup-duplicates"], {
    execFileSync: github.execFileSync,
    sleep: noSleep,
  });
  assert.deepEqual(
    github.state.releases.map((candidate) => candidate.id),
    [1, 2, 3],
  );
});

// Real processes racing against one file-backed fake `gh`: every creator lists before any
// creates, which is what happened on v0.15.913.
test("three concurrent --ensure processes leave one draft, which --publish then publishes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "github-release-race-"));
  try {
    const statePath = path.join(directory, "state.json");
    writeFileSync(statePath, JSON.stringify({ releases: [], nextId: 100, listedEmpty: 0 }));
    const ghPath = path.join(directory, "gh");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const lock = statePath + ".lock";
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withState(fn) {
  for (;;) { try { fs.mkdirSync(lock); break; } catch { pause(5); } }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const result = fn(state);
    fs.writeFileSync(statePath, JSON.stringify(state));
    return result;
  } finally { fs.rmdirSync(lock); }
}
const args = process.argv.slice(2);
if (args[1] === "repos/${REPO}/releases?per_page=100") {
  const empty = withState((state) => {
    if (state.releases.length > 0) return false;
    state.listedEmpty += 1;
    return true;
  });
  if (empty) {
    // Hold every empty answer until all three creators have seen the tag without a release.
    const deadline = Date.now() + 10000;
    while (withState((state) => state.listedEmpty) < 3 && Date.now() < deadline) pause(20);
    process.stdout.write("[]");
  } else {
    process.stdout.write(JSON.stringify(withState((state) => [...state.releases].sort((a, b) => b.id - a.id))));
  }
} else if (args[2] === "POST") {
  withState((state) => {
    const id = (state.nextId += 1);
    state.releases.push({ id, draft: true, name: "Paseo ${TAG}", tag_name: "${TAG}",
      html_url: "https://github.com/${REPO}/releases/tag/untagged-" + id, assets: [] });
  });
  process.stdout.write("{}");
} else if (args[2] === "PATCH") {
  const id = Number(args[3].split("/").pop());
  withState((state) => {
    const target = state.releases.find((r) => r.id === id);
    target.draft = false;
    target.html_url = "https://github.com/${REPO}/releases/tag/${TAG}";
  });
  process.stdout.write("{}");
} else if (args[2] === "DELETE") {
  const id = Number(args[3].split("/").pop());
  withState((state) => { state.releases = state.releases.filter((r) => r.id !== id); });
} else {
  process.stderr.write("unexpected gh " + args.join(" "));
  process.exit(1);
}
`,
      { mode: 0o755 },
    );
    const run = (mode = "--ensure") =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath, "--repo", REPO, "--tag", TAG, mode], {
          env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr }));
      });
    const results = await Promise.all([run(), run(), run()]);
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.listedEmpty, 3, "all three creators saw no release");
    assert.deepEqual(
      state.releases.map((candidate) => candidate.id),
      [101],
    );
    assert.deepEqual(
      results.map((result) => result.stdout),
      ["untagged-101", "untagged-101", "untagged-101"],
    );

    // npm then publishes the one draft once its tarballs are up.
    const publish = await run("--publish");
    assert.equal(publish.status, 0, publish.stderr);
    assert.equal(publish.stdout, TAG);
    const published = JSON.parse(readFileSync(statePath, "utf8")).releases;
    assert.deepEqual(
      published.map((candidate) => [candidate.id, candidate.draft]),
      [[101, false]],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
