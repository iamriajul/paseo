import { createServerFn } from "@tanstack/react-start";
import { getGitHubApiUrl, getWebsiteCacheContext } from "./cloudflare-cache";
import { getReleaseChannels } from "./latest-release";

export const getLatestRelease = createServerFn({ method: "GET" }).handler(async () => {
  return getReleaseChannels(getWebsiteCacheContext(), getGitHubApiUrl());
});
