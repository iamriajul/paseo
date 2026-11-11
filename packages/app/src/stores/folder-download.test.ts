import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { useDownloadStore, type Download } from "@/stores/download-store";
import { fakeDownloadStream, memoryDownloadDestination } from "@/test/memory-download-destination";
import { startFolderDownload } from "@/stores/folder-download";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

const localTcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

const profile: HostProfile = {
  serverId: "srv_remote",
  label: "Remote",
  appearance: defaultHostAppearance(),
  lifecycle: {},
  connections: [localTcpConnection, relayConnection],
  preferredConnectionId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function downloadFolder(input: {
  activeConnectionId: string;
  openStream?: () => Promise<ReturnType<typeof fakeDownloadStream>["stream"]>;
}) {
  const tokenRequests: number[] = [];
  const streamOpens: number[] = [];
  const destination = memoryDownloadDestination();
  await startFolderDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    fileName: "src.zip",
    daemonProfile: profile,
    activeConnectionId: input.activeConnectionId,
    requestToken: async () => {
      tokenRequests.push(1);
      return { token: "tok", fileName: "src.zip" };
    },
    openStream: async () => {
      streamOpens.push(1);
      if (input.openStream) return input.openStream();
      return fakeDownloadStream([ZIP_BYTES], {
        fileName: "src.zip",
        mimeType: "application/zip",
        size: null,
      }).stream;
    },
    prepareDestination: destination.prepare,
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  const download: Download | undefined = activeDownloadId
    ? downloads.get(activeDownloadId)
    : undefined;
  return { download, tokenRequests, streamOpens, destination };
}

describe("folder download transport selection", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("streams the zip over the session to disk when the active connection is the relay", async () => {
    const result = await downloadFolder({ activeConnectionId: relayConnection.id });

    expect(result.download).toMatchObject({ status: "complete", fileName: "src.zip" });
    expect(result.tokenRequests).toEqual([]);
    expect(result.streamOpens).toEqual([1]);
    expect([...result.destination.bytes()]).toEqual([...ZIP_BYTES]);
    expect(result.destination.events.at(1)).toEqual({
      type: "begin",
      target: { fileName: "src.zip", mimeType: "application/zip", size: null },
    });
  });

  it("uses the HTTP token route when the active connection is directTcp", async () => {
    const result = await downloadFolder({ activeConnectionId: localTcpConnection.id });

    expect(result.download).toMatchObject({ status: "complete" });
    expect(result.tokenRequests).toEqual([1]);
    expect(result.streamOpens).toEqual([]);
    expect(result.destination.events).toEqual([]);
  });

  it("fails the download with the daemon's reason and keeps no file", async () => {
    const result = await downloadFolder({
      activeConnectionId: relayConnection.id,
      openStream: async () => {
        throw new Error("Access outside of workspace is not allowed");
      },
    });

    expect(result.download).toMatchObject({
      status: "error",
      message: "Access outside of workspace is not allowed",
    });
    expect(result.destination.events.map((event) => event.type)).toEqual(["prepare", "discard"]);
  });
});
