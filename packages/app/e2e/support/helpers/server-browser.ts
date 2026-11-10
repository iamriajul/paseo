import http from "node:http";
import { expect } from "@playwright/test";
import { connectDaemonClient } from "./daemon-client-loader";
import { getE2EDaemonPort } from "./daemon-port";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";

type DaemonClient = import("@getpaseo/client/internal/daemon-client").DaemonClient;

/** The daemon config a server-browser spec runs with: Headless (light), browser tools for agents. */
export const SERVER_BROWSER_DAEMON_CONFIG = {
  version: 1,
  daemon: {
    browserTools: { enabled: true },
    serverBrowser: { enabled: true, engine: "headless", newTabTarget: "server" },
  },
};

export interface ServerBrowserScenario {
  workspace: SeededWorkspace;
  client: DaemonClient;
  agentId: string;
  siteUrl: string;
  /** Calls a browser MCP tool as the scenario's agent; returns its structured result. */
  tool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  newTab(path?: string): Promise<string>;
  listTabIds(): Promise<string[]>;
  close(): Promise<void>;
}

/** A workspace with a mock agent that drives the server browser through its MCP tools. */
export async function startServerBrowserScenario(
  routes: Record<string, string> = {},
): Promise<ServerBrowserScenario> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(routes[req.url ?? "/"] ?? "<title>Fixture</title><p>fixture</p>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  const siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const workspace = await seedWorkspace({ repoPrefix: "server-browser-" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "server-browser" });
  const agent = await client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Browser agent",
    modeId: "load-test",
  });
  const mcp = new Client({ name: "server-browser-agent", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents?callerAgentId=${agent.id}`),
    ),
  );
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await mcp.callTool({ name, arguments: args });
    return (response.structuredContent ?? {}) as Record<string, unknown>;
  };
  const resultOf = (structured: Record<string, unknown>) => {
    expect(structured, JSON.stringify(structured)).toMatchObject({ ok: true });
    return structured.result as Record<string, unknown>;
  };
  return {
    workspace,
    client,
    agentId: agent.id,
    siteUrl,
    tool,
    newTab: async (path = "/") =>
      String(resultOf(await tool("browser_new_tab", { url: `${siteUrl}${path}` })).browserId),
    listTabIds: async () =>
      ((resultOf(await tool("browser_list_tabs")).tabs as Array<{ browserId: string }>) ?? []).map(
        (tab) => tab.browserId,
      ),
    close: async () => {
      await mcp.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      await workspace.cleanup();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    },
  };
}
