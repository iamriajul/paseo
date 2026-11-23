import { defineConfig, devices } from "playwright/test";

const baseURL = process.env.WEBSITE_TEST_URL ?? "http://127.0.0.1:8187";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: process.env.WEBSITE_TEST_URL
    ? undefined
    : [
        {
          command: "node e2e/registry-server.mjs",
          url: "http://127.0.0.1:8188/index.json",
        },
        {
          command: "node e2e/github-server.mjs",
          url: "http://127.0.0.1:8189/repos/getpaseo/paseo",
        },
        {
          command: "npm run build && npm run preview -- --host 127.0.0.1 --port 8187 --strictPort",
          // Probe a static file so readiness never waits on an SSR loader.
          url: new URL("/logo.svg", baseURL).href,
          stdout: "pipe",
          env: {
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
            PLUGINS_REGISTRY_URL: "http://127.0.0.1:8188",
            // Every page's root loader reads GitHub: a live GitHub failure is a 500 on every page.
            GITHUB_API_URL: "http://127.0.0.1:8189",
          },
        },
      ],
});
