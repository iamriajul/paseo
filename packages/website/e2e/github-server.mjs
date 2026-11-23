import { createServer } from "node:http";

// The two GitHub API responses every page's root loader reads during SSR.
const version = "0.15.4";
const releases = [
  {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      `Paseo-${version}-arm64.dmg`,
      "Paseo-x86_64.AppImage",
      `Paseo-Setup-${version}-x64.exe`,
      `Paseo-Setup-${version}-arm64.exe`,
      `paseo-v${version}-android.apk`,
    ].map((name) => ({ name })),
  },
];
const repo = { stargazers_count: 4200 };

const responses = new Map([
  ["/repos/getpaseo/paseo", repo],
  ["/repos/getpaseo/paseo/releases", releases],
]);

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = responses.get(pathname);
  response.statusCode = body ? 200 : 404;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body ?? { message: "Not Found" }));
}).listen(8189, "127.0.0.1");
