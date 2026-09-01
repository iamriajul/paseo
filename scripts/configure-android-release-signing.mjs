import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/configure-android-release-signing.mjs [--gradle-file <android/app/build.gradle>]\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  let gradleFile = "packages/app/android/app/build.gradle";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gradle-file") {
      gradleFile = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!gradleFile) {
    usageAndExit();
  }

  return resolve(gradleFile);
}

const gradleFile = parseArgs(process.argv.slice(2));
let contents = readFileSync(gradleFile, "utf8");

if (!contents.includes("PASEO_ANDROID_KEYSTORE_FILE")) {
  const debugSigningConfig = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
`;

  const releaseSigningConfig = `${debugSigningConfig}        release {
            def releaseStoreFile = findProperty('PASEO_ANDROID_KEYSTORE_FILE')
            def releaseStorePassword = findProperty('PASEO_ANDROID_KEYSTORE_PASSWORD')
            def releaseKeyAlias = findProperty('PASEO_ANDROID_KEY_ALIAS')
            def releaseKeyPassword = findProperty('PASEO_ANDROID_KEY_PASSWORD')

            if (!releaseStoreFile || !releaseStorePassword || !releaseKeyAlias || !releaseKeyPassword) {
                throw new GradleException('Release signing requires PASEO_ANDROID_KEYSTORE_FILE, PASEO_ANDROID_KEYSTORE_PASSWORD, PASEO_ANDROID_KEY_ALIAS, and PASEO_ANDROID_KEY_PASSWORD Gradle properties.')
            }

            storeFile file(releaseStoreFile)
            storePassword releaseStorePassword
            keyAlias releaseKeyAlias
            keyPassword releaseKeyPassword
        }
`;

  if (!contents.includes(debugSigningConfig)) {
    throw new Error(`Could not find Expo debug signing config in ${gradleFile}`);
  }

  contents = contents.replace(debugSigningConfig, releaseSigningConfig);
}

const debugReleaseSigning = `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;
const releaseSigning = `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.release`;

if (contents.includes(debugReleaseSigning)) {
  contents = contents.replace(debugReleaseSigning, releaseSigning);
} else if (!contents.includes(releaseSigning)) {
  throw new Error(`Could not find release buildType signing config in ${gradleFile}`);
}

writeFileSync(gradleFile, contents);
