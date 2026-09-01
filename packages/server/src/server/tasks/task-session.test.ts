import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionOutboundMessage } from "../messages.js";
import { DownloadTokenStore } from "../file-download/token-store.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";
import { TaskSession } from "./task-session.js";
import { TaskStore } from "./task-store.js";

const tempDirs: string[] = [];

describe("task session", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects mutations for archived projects before touching stored tasks", async () => {
    const { store, session, messages } = makeTaskSession();
    const task = await store.create({
      projectId: "project/one",
      title: "Active task",
      description: "",
      uploads: [],
    });

    await session.handleUpdate({
      type: "tasks.update.request",
      requestId: "update-1",
      projectId: "project/archived",
      taskId: task.id,
      title: "Wrong project",
    });

    expect(messages).toMatchObject([
      {
        type: "tasks.update.response",
        payload: {
          requestId: "update-1",
          task: null,
          error: "Project not found: project/archived",
        },
      },
    ]);
    await expect(store.list("project/one")).resolves.toMatchObject([
      {
        id: task.id,
        title: "Active task",
      },
    ]);
  });

  it("returns a server-local attachment path with task download tokens", async () => {
    const { paseoHome, store, session, messages } = makeTaskSession();
    const uploadPath = writeUploadedFile(paseoHome, "upload-task-1", "notes.md", "hello");
    const task = await store.create({
      projectId: "project/one",
      title: "Task with attachment",
      description: "",
      uploads: [
        {
          type: "uploaded_file",
          id: "upload-task-1",
          fileName: "notes.md",
          mimeType: "text/markdown",
          size: 5,
          path: uploadPath,
        },
      ],
    });
    const attachment = task.attachments[0];
    if (!attachment) {
      throw new Error("expected task attachment");
    }

    await session.handleAttachmentDownloadToken({
      type: "tasks.attachment.download_token.request",
      requestId: "token-1",
      projectId: "project/one",
      taskId: task.id,
      attachmentId: attachment.id,
    });

    expect(messages).toMatchObject([
      {
        type: "tasks.attachment.download_token.response",
        payload: {
          requestId: "token-1",
          taskId: task.id,
          attachmentId: attachment.id,
          token: expect.any(String),
          path: expect.stringContaining(join("tasks", "assets")),
          fileName: "notes.md",
          mimeType: "text/markdown",
          size: 5,
          error: null,
        },
      },
    ]);
    const payload = messages[0]?.payload;
    if (!payload || !("path" in payload) || payload.path === null) {
      throw new Error("expected attachment path");
    }
    expect(readFileSync(payload.path, "utf8")).toBe("hello");
  });

  it("lists backlog tasks from active projects only", async () => {
    const { store, session, messages } = makeTaskSession();
    const activeTask = await store.create({
      projectId: "project/one",
      title: "Active task",
      description: "",
      uploads: [],
    });
    await store.create({
      projectId: "project/archived",
      title: "Archived task",
      description: "",
      uploads: [],
    });

    await session.handleListAll({
      type: "tasks.list_all.request",
      requestId: "list-all-1",
    });

    expect(messages).toMatchObject([
      {
        type: "tasks.list_all.response",
        payload: {
          requestId: "list-all-1",
          tasks: [
            {
              id: activeTask.id,
              projectId: "project/one",
              title: "Active task",
            },
          ],
          error: null,
        },
      },
    ]);
  });
});

function makeTaskSession() {
  const paseoHome = makePaseoHome();
  const store = new TaskStore(paseoHome);
  const messages: SessionOutboundMessage[] = [];
  const session = new TaskSession({
    host: {
      emit: (message) => messages.push(message),
    },
    store,
    projectRegistry: createProjectRegistry([
      makeProjectRecord("project/one", null),
      makeProjectRecord("project/archived", "2026-07-07T00:00:00.000Z"),
    ]),
    downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
  });
  return { paseoHome, store, session, messages };
}

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "task-session-test-")));
  tempDirs.push(root);
  return root;
}

function makeProjectRecord(projectId: string, archivedAt: string | null): PersistedProjectRecord {
  return {
    projectId,
    rootPath: `/tmp/${projectId}`,
    kind: "git",
    displayName: projectId,
    customName: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    archivedAt,
  };
}

function createProjectRegistry(records: readonly PersistedProjectRecord[]): ProjectRegistry {
  const projects = new Map(records.map((record) => [record.projectId, record]));
  return {
    initialize: async () => undefined,
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (projectId) => projects.get(projectId) ?? null,
    upsert: async (record) => {
      projects.set(record.projectId, record);
    },
    archive: async (projectId, archivedAt) => {
      const current = projects.get(projectId);
      if (current) {
        projects.set(projectId, { ...current, archivedAt });
      }
    },
    remove: async (projectId) => {
      projects.delete(projectId);
    },
  };
}

function writeUploadedFile(
  paseoHome: string,
  uploadId: string,
  fileName: string,
  contents: string,
): string {
  const uploadDir = join(paseoHome, "uploads", uploadId);
  mkdirSync(uploadDir, { recursive: true });
  const uploadPath = join(uploadDir, fileName);
  writeFileSync(uploadPath, contents);
  return uploadPath;
}
