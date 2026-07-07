# Android

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js` (vanilla Expo, no custom Gradle plugin):

| Variant       | App name    | Package ID       |
| ------------- | ----------- | ---------------- |
| `production`  | Paseo       | `sh.paseo`       |
| `development` | Paseo Debug | `sh.paseo.debug` |

Fork release builds can override the production identity with:

- `PASEO_ANDROID_APP_NAME` — launcher name, for example `Paseo iamriajul`
- `PASEO_ANDROID_PACKAGE_ID` — Android package ID, for example `sh.paseo.iamriajul`
- `PASEO_URL_SCHEME` — deep-link scheme, for example `paseo-iamriajul`

When `PASEO_FORK_ID_SUFFIX` is set instead, `packages/app/app.config.js` derives the package ID from the official package plus that suffix. Fork builds disable the upstream EAS Update URL unless `PASEO_EXPO_UPDATES_URL` is explicitly set, so a fork APK does not later load upstream JavaScript.

EAS profiles: `development`, `production`, and `production-apk` in `packages/app/eas.json`.

`development` uses Android `debug`.

## Local build + install

From repo root:

```bash
npm run android:development    # Debug build
npm run android:production     # Release build
npm run android:clear          # Remove generated Android project
```

Or from `packages/app`:

```bash
# Debug
npx cross-env APP_VARIANT=development expo prebuild --platform android --non-interactive
npx cross-env APP_VARIANT=development expo run:android --variant=debug

# Release
npx cross-env APP_VARIANT=production expo prebuild --platform android --non-interactive
npx cross-env APP_VARIANT=production expo run:android --variant=release

# Clear generated Android project
rm -rf android
```

### React version lockstep

Keep `react` and `react-dom` pinned to the React version embedded by the current `react-native` release. React Native `0.81.x` embeds `react-native-renderer` `19.1.0`, so `packages/app` must use React `19.1.0`. Bumping React to a newer patch can build successfully but crash at JS startup on Android with `Incompatible React versions`, leaving the app on the native splash screen.

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```

## Cloud build + submit (EAS)

Stable tag pushes like `v0.1.0` trigger:

- The EAS GitHub app on Expo servers (iOS + Android production builds + store submit). There is no workflow file in this repo for it.
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release).

iOS auto-submits to App Store review via a Fastlane lane after EAS uploads to TestFlight. Android auto-submits to the Play Store via EAS-managed credentials.

Beta tags like `v0.1.1-beta.1` only trigger the GitHub APK workflow. They publish a GitHub prerelease APK for testing and do not submit to the stores.

`android-v*` tags also trigger only the GitHub APK workflow — useful when you want to ship an APK without going through stores. The GitHub APK workflow supports `workflow_dispatch` with an existing `tag` input so you can rebuild without cutting a new tag.

In forks, `.github/workflows/android-apk-release.yml` does not use Expo Cloud. It runs `expo prebuild` in GitHub Actions, patches the generated Gradle project to use release signing, builds `:app:assembleRelease`, and uploads a signed APK. Configure these fork secrets for secure signing:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

If none of those secrets are configured, fork builds use the committed public insecure fallback key at `scripts/android-insecure-fallback-upload-keystore.jks.base64`. The fallback key uses alias/password `paseo-insecure-fallback`, and its SHA-256 certificate fingerprint is `E9:41:27:CD:30:09:3A:47:53:C9:30:0A:C8:CB:B5:5D:84:88:30:14:1B:8B:F5:EC:A0:52:ED:42:8E:89:7B:BE`. Fallback APK release assets include `INSECURE-PUBLIC-FALLBACK-KEY` in the APK filename and upload a warning text file beside the APK. Use this path only for easy fork testing; anyone with the repo can sign an APK with the same fallback key.

If only some Android signing secrets are configured, the workflow fails so a partially configured secure signing setup is not silently downgraded.

Fork APKs derive `PASEO_ANDROID_VERSION_CODE` from the release tag so future APKs with the same package ID can update in place.

### Useful commands

```bash
cd packages/app

# Recent builds
npx eas build:list --limit 10 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# Inspect a build (the printed `Logs` URL opens the build's Expo dashboard page,
# which has a Submissions section showing the auto-submit to the Play Store).
npx eas build:view <build-id>
```

The Play Console (Internal testing → Production tracks) is the final confirmation that the binary reached the store.

See [docs/release.md](release.md) for the full mobile-build babysitting flow.
