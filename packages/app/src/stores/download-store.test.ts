import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import type { SessionDownloadStream } from "@/downloads/session-download";
import { fakeDownloadStream, memoryDownloadDestination } from "@/test/memory-download-destination";
import {
  MAX_SESSION_DOWNLOAD_BYTES,
  useDownloadStore,
  type Download,
  type DownloadedBytes,
} from "@/stores/download-store";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/données été.bin";
const FILE_NAME = "données été.bin";
const MIME_TYPE = "application/octet-stream";

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

// The #3753 shape: the relay hostname stored as a directTcp entry that nothing can reach.
const staleTcpConnection: DirectTcpHostConnection = {
  id: "direct:relay.paseo.sh:443",
  type: "directTcp",
  endpoint: "relay.paseo.sh:443",
};

const localTcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

function profileWith(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "srv_remote",
    label: "Remote",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createTokenRequest(size: number | null = FILE_BYTES.byteLength) {
  const requested: string[] = [];
  return {
    requested,
    request: async (path: string) => {
      requested.push(path);
      return { token: "tok", fileName: FILE_NAME, mimeType: MIME_TYPE, size, error: null };
    },
  };
}

function createFileReader(read: () => Promise<{ bytes: Uint8Array; size: number }>) {
  const requested: string[] = [];
  return {
    requested,
    read: async (path: string) => {
      requested.push(path);
      return read();
    },
  };
}

function createFileSaver() {
  const savedFiles: DownloadedBytes[] = [];
  return {
    savedFiles,
    save: async (file: DownloadedBytes) => {
      savedFiles.push(file);
      return null;
    },
  };
}

interface StartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  token?: ReturnType<typeof createTokenRequest>;
  reader?: ReturnType<typeof createFileReader>;
  saver?: ReturnType<typeof createFileSaver>;
}

async function startDownload(input: StartInput): Promise<Download | undefined> {
  const token = input.token ?? createTokenRequest();
  const reader =
    input.reader ??
    createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }));
  const saver = input.saver ?? createFileSaver();
  await useDownloadStore.getState().startDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    daemonProfile: input.profile,
    activeConnectionId: input.activeConnectionId,
    requestFileDownloadToken: token.request,
    openStream: null,
    readFile: reader.read,
    saveFile: saver.save,
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store streamed session downloads", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  function start(input: {
    activeConnectionId: string;
    open: (signal: AbortSignal) => Promise<SessionDownloadStream>;
    destination: ReturnType<typeof memoryDownloadDestination>;
  }) {
    const token = createTokenRequest();
    const reader = createFileReader(async () => ({ bytes: FILE_BYTES, size: 0 }));
    const done = useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([localTcpConnection, relayConnection]),
      activeConnectionId: input.activeConnectionId,
      requestFileDownloadToken: token.request,
      openStream: input.open,
      readFile: reader.read,
      prepareDestination: input.destination.prepare,
    });
    return { done, token, reader };
  }

  function activeDownload(): Download | undefined {
    const { activeDownloadId, downloads } = useDownloadStore.getState();
    return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
  }

  it("streams a file over the relay to disk with no size cap and no token", async () => {
    const size = MAX_SESSION_DOWNLOAD_BYTES + 3;
    const chunks = [new Uint8Array(MAX_SESSION_DOWNLOAD_BYTES), new Uint8Array([1, 2, 3])];
    const destination = memoryDownloadDestination();
    const { stream } = fakeDownloadStream(chunks, {
      fileName: FILE_NAME,
      mimeType: MIME_TYPE,
      size,
    });

    const { done, token, reader } = start({
      activeConnectionId: relayConnection.id,
      open: async () => stream,
      destination,
    });
    await done;

    expect(activeDownload()).toMatchObject({ status: "complete", fileName: FILE_NAME });
    expect(destination.bytes().byteLength).toBe(size);
    expect(destination.events[0]).toEqual({ type: "prepare", suggestedName: FILE_NAME });
    expect(token.requested).toEqual([]);
    expect(reader.requested).toEqual([]);
  });

  it("opens the save prompt before anything is awaited", () => {
    const destination = memoryDownloadDestination();
    void start({
      activeConnectionId: relayConnection.id,
      open: async () =>
        fakeDownloadStream([FILE_BYTES], { fileName: FILE_NAME, mimeType: MIME_TYPE, size: null })
          .stream,
      destination,
    });

    // Synchronously, in the same tick as the tap.
    expect(destination.events).toEqual([{ type: "prepare", suggestedName: FILE_NAME }]);
  });

  it("removes a cancelled download and drops its partial file", async () => {
    const destination = memoryDownloadDestination({
      onWrite: () => {
        const download = activeDownload();
        expect(download?.cancellable).toBe(true);
        useDownloadStore.getState().cancelDownload(download!.id);
      },
    });
    const { done } = start({
      activeConnectionId: relayConnection.id,
      open: async (signal) => ({
        fileName: FILE_NAME,
        mimeType: MIME_TYPE,
        size: 6,
        chunks: (async function* () {
          for (const chunk of [new Uint8Array(3), new Uint8Array(3)]) {
            if (signal.aborted) throw signal.reason;
            yield chunk;
          }
        })(),
      }),
      destination,
    });
    await done;

    expect(useDownloadStore.getState().downloads.size).toBe(0);
    expect(destination.events.at(-1)).toMatchObject({ type: "abort" });
  });

  it("keeps the HTTP route on directTcp even when the daemon can stream", async () => {
    const destination = memoryDownloadDestination();
    const { done, token } = start({
      activeConnectionId: localTcpConnection.id,
      open: async () => {
        throw new Error("must not stream");
      },
      destination,
    });
    await done;

    expect(token.requested).toEqual([FILE_PATH]);
    expect(destination.events).toEqual([]);
  });
});

describe("download store transport selection", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("downloads over the session when the active connection is the relay", async () => {
    const token = createTokenRequest();
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({ fileName: FILE_NAME, status: "complete" });
    expect(token.requested).toEqual([FILE_PATH]);
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("bounds the session read even when the token reports a smaller file", async () => {
    const readRequests: Array<{ path: string; maxBytes: number }> = [];
    const saver = createFileSaver();
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(1).request,
      openStream: null,
      readFile: async (path: string, maxBytes: number) => {
        readRequests.push({ path, maxBytes });
        return { bytes: FILE_BYTES, size: FILE_BYTES.byteLength };
      },
      saveFile: saver.save,
    });
    expect(readRequests).toEqual([{ path: FILE_PATH, maxBytes: MAX_SESSION_DOWNLOAD_BYTES }]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("ignores a directTcp entry that is not the active connection", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([staleTcpConnection, relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toHaveLength(1);
  });

  it("keeps the HTTP token download when the active connection is directTcp", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([localTcpConnection, relayConnection]),
      activeConnectionId: localTcpConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails the download and saves nothing when the session read fails", async () => {
    const reader = createFileReader(async () => {
      throw new Error("Connection lost");
    });
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: "Connection lost" });
    expect(saver.savedFiles).toEqual([]);
  });

  it("refuses a file over the session size limit before reading it", async () => {
    const token = createTokenRequest(MAX_SESSION_DOWNLOAD_BYTES + 1);
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("composer.errors.fileTooLarge", { fileName: FILE_NAME, size: "64 MB" }),
    });
    expect(download?.message).toContain("64 MB");
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails instead of saving an empty file when the daemon returns no content", async () => {
    const reader = createFileReader(async () => ({ bytes: new Uint8Array(), size: 6 }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: "File transfer incomplete: expected 6 bytes, received 0.",
    });
    expect(saver.savedFiles).toEqual([]);
  });
});
