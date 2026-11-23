import { env, waitUntil } from "cloudflare:workers";
import type { WebsiteCacheContext } from "./github-cache";

export function getWebsiteCacheContext(): WebsiteCacheContext {
  return {
    cache: (env as { WEBSITE_CACHE?: KVNamespace }).WEBSITE_CACHE ?? null,
    waitUntil,
  };
}

const GITHUB_API_URL = "https://api.github.com";

/**
 * Every page's root loader blocks on GitHub while the cache is cold, so a GitHub
 * failure is a 500 on every page. The website e2e run points this at a local
 * fixture server (`e2e/github-server.mjs`) so it never depends on live GitHub.
 */
export function getGitHubApiUrl(): string {
  return (env as { GITHUB_API_URL?: string }).GITHUB_API_URL ?? GITHUB_API_URL;
}
