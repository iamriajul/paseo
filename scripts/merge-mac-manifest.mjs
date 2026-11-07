import fs from "node:fs";
import { dump, load } from "js-yaml";
import { isMainModule } from "./is-main-module.mjs";

// electron-updater compares this with os.release(), which reports the Darwin
// kernel version. Darwin 22 is macOS 13 Ventura.
export const MACOS_MINIMUM_DARWIN_VERSION = "22.0.0";

// The first manifest's top-level fields win. Pass arm64 first when both arches built; a
// release whose targets enable one arch passes only that arch's manifest.
export function mergeMacManifest(inputPaths, outputPath) {
  if (inputPaths.length === 0) throw new Error("mergeMacManifest needs at least one manifest");
  const manifests = inputPaths.map((inputPath) => load(fs.readFileSync(inputPath, "utf8")));
  const files = manifests
    .flatMap((manifest) => manifest.files ?? [])
    .filter((file, index, all) => all.findIndex((entry) => entry.url === file.url) === index);
  const output = dump(
    { ...manifests[0], files, minimumSystemVersion: MACOS_MINIMUM_DARWIN_VERSION },
    { lineWidth: -1, noRefs: true },
  );
  fs.writeFileSync(outputPath, output);
  return output;
}

if (isMainModule(import.meta.url)) {
  const [, , outputPath, ...inputPaths] = process.argv;
  if (!outputPath || inputPaths.length === 0) {
    throw new Error("Usage: node scripts/merge-mac-manifest.mjs <out.yml> <arm64.yml> [x64.yml]");
  }
  process.stdout.write(mergeMacManifest(inputPaths, outputPath));
}
