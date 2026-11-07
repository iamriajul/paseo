import { isMainModule } from "./is-main-module.mjs";

// Every artifact a release tag can build. docs/fork-release.md#release-targets owns the
// meaning of each name; workflows read the per-target outputs this script prints.
export const RELEASE_TARGETS = [
  "desktop-macos-arm64",
  "desktop-macos-x64",
  "desktop-windows",
  "desktop-linux",
  "android-apk",
  "android-browser-native",
  "docker",
  "npm",
];

export const DEFAULT_RELEASE_TARGETS = ["desktop-macos-arm64", "android-apk"];

// A scope other than `all` is an explicit request: a platform tag (desktop-macos-v1.2.3),
// the desktop workflow's `platform` input, or dispatching a single-target workflow. It
// builds what it names, whatever the repository variable says.
const SCOPES = {
  all: RELEASE_TARGETS,
  desktop: ["desktop-macos-arm64", "desktop-macos-x64", "desktop-windows", "desktop-linux"],
  macos: ["desktop-macos-arm64", "desktop-macos-x64"],
  linux: ["desktop-linux"],
  windows: ["desktop-windows"],
  ...Object.fromEntries(RELEASE_TARGETS.map((target) => [target, [target]])),
};

const MACOS_RUNNERS = {
  "desktop-macos-arm64": { runner: "macos-latest", electron_arch: "arm64", node_heap_mb: 4096 },
  // GitHub has no standard macos-latest-intel alias; use the newest Intel image.
  "desktop-macos-x64": { runner: "macos-26-intel", electron_arch: "x64", node_heap_mb: 8192 },
};

export function parseReleaseTargets(value) {
  const names = (value ?? "").split(/[\s,]+/).filter(Boolean);
  if (names.length === 0) return null;
  if (names.length === 1 && names[0] === "all") return [...RELEASE_TARGETS];
  const unknown = names.filter((name) => !RELEASE_TARGETS.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown release target(s): ${unknown.join(", ")}. Valid targets: all, ${RELEASE_TARGETS.join(", ")}`,
    );
  }
  return RELEASE_TARGETS.filter((target) => names.includes(target));
}

// input: a dispatch's `targets` input. variable: vars.RELEASE_TARGETS. scope: see SCOPES.
export function resolveReleaseTargets({ input, variable, scope = "all" }) {
  const scoped = SCOPES[scope];
  if (!scoped) {
    throw new Error(
      `Unknown release scope: ${scope}. Valid scopes: ${Object.keys(SCOPES).join(", ")}`,
    );
  }
  const requested =
    parseReleaseTargets(input) ??
    (scope === "all" ? (parseReleaseTargets(variable) ?? DEFAULT_RELEASE_TARGETS) : scoped);
  return requested.filter((target) => scoped.includes(target));
}

export function formatGithubOutput(enabled) {
  const macosMatrix = enabled
    .filter((target) => target in MACOS_RUNNERS)
    .map((t) => MACOS_RUNNERS[t]);
  return [
    `targets=${enabled.join(",")}`,
    ...RELEASE_TARGETS.map((target) => `${target}=${enabled.includes(target)}`),
    `desktop-macos=${macosMatrix.length > 0}`,
    `macos-matrix=${JSON.stringify({ include: macosMatrix })}`,
    "",
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  const enabled = resolveReleaseTargets({
    input: process.env.RELEASE_TARGETS_INPUT,
    variable: process.env.RELEASE_TARGETS_VARIABLE,
    scope: process.env.RELEASE_TARGETS_SCOPE || "all",
  });
  process.stderr.write(`Release targets: ${enabled.join(", ") || "(none)"}\n`);
  process.stdout.write(formatGithubOutput(enabled));
}
