// Agent browser tools on desktop tabs whose page is still loading: a subresource that never
// finishes, a document the server answers late, a script redirect, and a script that is still
// running when the page navigates. Each call must answer within the daemon broker's 15 s budget.

import { createServer } from "node:http";

const BROKER_TIMEOUT_MS = 15_000;

export async function startLoadingTargetServer() {
  const heldResponses = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const html = (body) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>${url.pathname}</title></head><body>${body}</body></html>`,
      );
    };
    if (url.pathname === "/hanging-image") {
      // Never answered: the page's load event never fires.
      heldResponses.add(response);
      response.on("close", () => heldResponses.delete(response));
      return;
    }
    if (url.pathname === "/hanging") {
      html(
        `<h1>Hanging page ${url.search}</h1><button>Loaded DOM</button><img src="/hanging-image?${Date.now()}">`,
      );
      return;
    }
    if (url.pathname === "/redirect") {
      html(`<script>location.replace("/landing")</script><img src="/hanging-image?${Date.now()}">`);
      return;
    }
    if (url.pathname === "/slow-document") {
      setTimeout(() => html(`<h1>Slow document</h1>`), Number(url.searchParams.get("ms") ?? 0));
      return;
    }
    html(`<h1>Page ${url.pathname}</h1>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const response of heldResponses) response.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function timedTool(client, name, args) {
  const startedAt = Date.now();
  const response = await client.callTool({ name, args });
  const payload = response.structuredContent;
  return { payload, elapsedMs: Date.now() - startedAt };
}

function describe(call) {
  return `${JSON.stringify(call.payload)} after ${call.elapsedMs} ms`;
}

export async function runBrowserLoadingRegression({ client, baseUrl }) {
  const failures = [];
  const expectOk = (label, call, budgetMs) => {
    if (call.payload?.ok !== true) {
      failures.push(`${label}: ${describe(call)}`);
      return null;
    }
    if (call.elapsedMs > budgetMs) {
      failures.push(`${label} took ${call.elapsedMs} ms (budget ${budgetMs} ms)`);
    }
    return call.payload.result;
  };

  const created = await timedTool(client, "browser_new_tab", { url: `${baseUrl}/hanging?first` });
  const createdResult = expectOk("new_tab on a page whose image never loads", created, 10_000);
  if (!createdResult) {
    throw new Error(`Browser loading regressions:\n- ${failures.join("\n- ")}`);
  }
  const browserId = createdResult.browserId;

  const snapshot = expectOk(
    "snapshot while an image is still loading",
    await timedTool(client, "browser_snapshot", { browserId }),
    5_000,
  );
  if (snapshot && !snapshot.snapshot.includes("Loaded DOM")) {
    failures.push(`snapshot while an image is still loading missed the DOM: ${snapshot.snapshot}`);
  }
  expectOk(
    "evaluate while an image is still loading",
    await timedTool(client, "browser_evaluate", { browserId, function: "() => document.title" }),
    5_000,
  );
  expectOk(
    "wait for text while an image is still loading",
    await timedTool(client, "browser_wait", { browserId, text: "Loaded DOM" }),
    5_000,
  );
  expectOk(
    "screenshot while an image is still loading",
    await timedTool(client, "browser_screenshot", { browserId }),
    7_000,
  );
  expectOk(
    "navigate to a page whose image never loads",
    await timedTool(client, "browser_navigate", { browserId, url: `${baseUrl}/hanging?second` }),
    5_000,
  );

  const redirected = await timedTool(client, "browser_navigate", {
    browserId,
    url: `${baseUrl}/redirect`,
  });
  expectOk("navigate to a page that redirects by script", redirected, 5_000);
  expectOk(
    "wait for the script redirect target",
    await timedTool(client, "browser_wait", { browserId, url: "/landing" }),
    5_000,
  );

  const slowNavigation = await timedTool(client, "browser_navigate", {
    browserId,
    url: `${baseUrl}/slow-document?ms=14000`,
  });
  if (
    slowNavigation.payload?.ok !== false ||
    slowNavigation.payload.error?.code !== "browser_timeout"
  ) {
    failures.push(
      `navigate to a document answered after 14 s did not time out: ${describe(slowNavigation)}`,
    );
  } else {
    if (slowNavigation.elapsedMs >= BROKER_TIMEOUT_MS) {
      failures.push(`slow navigate hit the broker timeout: ${describe(slowNavigation)}`);
    }
    if (!/still loading/i.test(slowNavigation.payload.error.message)) {
      failures.push(
        `slow navigate error does not say what to do next: ${describe(slowNavigation)}`,
      );
    }
  }
  expectOk(
    "evaluate while the next document is pending",
    await timedTool(client, "browser_evaluate", { browserId, function: "() => location.pathname" }),
    5_000,
  );
  expectOk(
    "wait for the slow document to commit",
    await timedTool(client, "browser_wait", { browserId, url: "slow-document", timeoutMs: 10_000 }),
    12_000,
  );

  const navigatedDuringScript = await timedTool(client, "browser_evaluate", {
    browserId,
    function:
      "() => { setTimeout(() => { location.href = '/landing?after-script'; }, 100); return new Promise(() => {}); }",
  });
  if (navigatedDuringScript.payload?.ok !== false) {
    failures.push(`evaluate across a navigation did not fail: ${describe(navigatedDuringScript)}`);
  } else if (
    navigatedDuringScript.elapsedMs >= BROKER_TIMEOUT_MS ||
    !/navigated/i.test(navigatedDuringScript.payload.error.message)
  ) {
    failures.push(
      `evaluate across a navigation did not say the page navigated: ${describe(navigatedDuringScript)}`,
    );
  }

  expectOk(
    "navigate before reload",
    await timedTool(client, "browser_navigate", {
      browserId,
      url: `${baseUrl}/slow-document?ms=6000`,
    }),
    10_000,
  );
  expectOk(
    "reload a slow document",
    await timedTool(client, "browser_reload", { browserId }),
    3_000,
  );
  expectOk(
    "evaluate while a reload is pending",
    await timedTool(client, "browser_evaluate", { browserId, function: "() => 1" }),
    3_000,
  );
  expectOk("close the tab", await timedTool(client, "browser_close_tab", { browserId }), 5_000);

  if (failures.length > 0) {
    throw new Error(`Browser loading regressions:\n- ${failures.join("\n- ")}`);
  }
  return { browserId, loadingPages: "passed" };
}
