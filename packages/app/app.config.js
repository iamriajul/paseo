const fs = require("node:fs");
const path = require("node:path");
const pkg = require("./package.json");
const appVariant = process.env.APP_VARIANT ?? "production";
const forkIdSuffix = process.env.PASEO_FORK_ID_SUFFIX?.trim();
const explicitAndroidPackageId = process.env.PASEO_ANDROID_PACKAGE_ID?.trim();
const explicitAndroidAppName = process.env.PASEO_ANDROID_APP_NAME?.trim();
const explicitUrlScheme = process.env.PASEO_URL_SCHEME?.trim();
const explicitExpoUpdatesUrl = process.env.PASEO_EXPO_UPDATES_URL?.trim();
const explicitExpoProjectId = process.env.PASEO_EXPO_PROJECT_ID?.trim();
const explicitExpoOwner = process.env.PASEO_EXPO_OWNER?.trim();
const androidVersionCode = Number.parseInt(process.env.PASEO_ANDROID_VERSION_CODE ?? "", 10);
const isForkBuild = Boolean(
  forkIdSuffix ||
  explicitAndroidPackageId ||
  explicitAndroidAppName ||
  explicitUrlScheme ||
  explicitExpoUpdatesUrl ||
  explicitExpoProjectId ||
  explicitExpoOwner,
);

function resolveSecretFile(params) {
  const fromEnv = process.env[params.envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const fallbackAbsolutePath = path.resolve(__dirname, params.fallbackRelativePath);
  if (fs.existsSync(fallbackAbsolutePath)) {
    return params.fallbackRelativePath;
  }

  return undefined;
}

function optionalEnv(value) {
  return value && value.length > 0 ? value : undefined;
}

function resolveAppName(defaultName) {
  return optionalEnv(explicitAndroidAppName) ?? defaultName;
}

function resolvePackageId(defaultPackageId) {
  if (explicitAndroidPackageId) {
    return explicitAndroidPackageId;
  }

  if (forkIdSuffix) {
    return `${defaultPackageId}.${forkIdSuffix}`;
  }

  return defaultPackageId;
}

function resolveUpdatesConfig() {
  if (explicitExpoUpdatesUrl) {
    return { url: explicitExpoUpdatesUrl };
  }

  if (isForkBuild) {
    return { enabled: false };
  }

  return {
    url: "https://u.expo.dev/0e7f65ce-0367-46c8-a238-2b65963d235a",
  };
}

function resolveExpoProjectId() {
  if (explicitExpoProjectId) {
    return explicitExpoProjectId;
  }

  return isForkBuild ? undefined : "0e7f65ce-0367-46c8-a238-2b65963d235a";
}

function resolveExpoOwner() {
  if (explicitExpoOwner) {
    return explicitExpoOwner;
  }

  return isForkBuild ? undefined : "getpaseo";
}

const variants = {
  production: {
    name: resolveAppName("Paseo"),
    packageId: resolvePackageId("sh.paseo"),
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_PROD",
      fallbackRelativePath: "./.secrets/google-services.prod.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_PROD",
      fallbackRelativePath: "./.secrets/GoogleService-Info.prod.plist",
    }),
  },
  development: {
    name: resolveAppName("Paseo Debug"),
    packageId: resolvePackageId("sh.paseo.debug"),
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_DEBUG",
      fallbackRelativePath: "./.secrets/google-services.debug.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_DEBUG",
      fallbackRelativePath: "./.secrets/GoogleService-Info.debug.plist",
    }),
  },
};

const variant = variants[appVariant] ?? variants.production;
const expoProjectId = resolveExpoProjectId();
const expoOwner = resolveExpoOwner();

export default {
  expo: {
    name: variant.name,
    slug: "voice-mobile",
    version: pkg.version,
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: explicitUrlScheme || "paseo",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    runtimeVersion: {
      policy: "appVersion",
    },
    updates: resolveUpdatesConfig(),
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSMicrophoneUsageDescription: "This app needs access to the microphone for voice commands.",
        ITSAppUsesNonExemptEncryption: false,
      },
      bundleIdentifier: variant.packageId,
      ...(variant.googleServiceInfoPlist
        ? { googleServicesFile: variant.googleServiceInfoPlist }
        : {}),
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#000000",
        foregroundImage: "./assets/images/android-icon-foreground.png",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
      // Allow HTTP connections for local network hosts (required for release builds)
      usesCleartextTraffic: true,
      permissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "CAMERA",
        "android.permission.CAMERA",
      ],
      package: variant.packageId,
      ...(Number.isInteger(androidVersionCode) && androidVersionCode > 0
        ? { versionCode: androidVersionCode }
        : {}),
      ...(variant.googleServicesFile ? { googleServicesFile: variant.googleServicesFile } : {}),
    },
    web: {
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "expo-router",
      "@config-plugins/react-native-pdf",
      [
        "expo-camera",
        {
          cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
      [
        "expo-notifications",
        {
          icon: "./assets/images/notification-icon.png",
          color: "#20744A",
        },
      ],
      "expo-audio",
      [
        "expo-build-properties",
        {
          android: {
            minSdkVersion: 29,
            kotlinVersion: "2.1.20",
            // Allow HTTP connections for local network hosts in release builds
            usesCleartextTraffic: true,
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      router: {},
      ...(expoProjectId ? { eas: { projectId: expoProjectId } } : {}),
    },
    ...(expoOwner ? { owner: expoOwner } : {}),
  },
};
