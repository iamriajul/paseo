import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TaskStore } from "./task-store.js";

const tempDirs: string[] = [];

describe("task store", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists project tasks, imports attachments, and removes owned assets on delete", async () => {
    const paseoHome = makePaseoHome();
    const store = new TaskStore(paseoHome);
    const uploadPath = writeUploadedFile(paseoHome, "upload-task-1", "notes.md", "hello");

    const created = await store.create({
      projectId: "project/one",
      title: "  First task  ",
      description: "**body**",
      uploads: [
        {
          type: "uploaded_file",
          id: "upload-task-1",
          fileName: "../notes.md",
          mimeType: "text/markdown",
          size: 5,
          path: uploadPath,
        },
      ],
    });

    expect(created.title).toBe("First task");
    expect(created.attachments).toHaveLength(1);
    expect(created.attachments[0]?.fileName).toBe("notes.md");
    expect(Object.hasOwn(created.attachments[0] ?? {}, "absolutePath")).toBe(false);
    expect(existsSync(uploadPath)).toBe(false);

    const persisted = readPersistedPayload(paseoHome);
    const assetPath = persisted.tasks[0]?.attachments[0]?.absolutePath;
    expect(assetPath).toEqual(expect.any(String));
    expect(readFileSync(assetPath, "utf8")).toBe("hello");

    await expect(store.list("project/one")).resolves.toMatchObject([
      {
        id: created.id,
        projectId: "project/one",
        title: "First task",
        description: "**body**",
        status: "active",
        attachments: [{ fileName: "notes.md", mimeType: "text/markdown", size: 5 }],
      },
    ]);
    await expect(store.list("project/two")).resolves.toEqual([]);

    const updated = await store.update({
      projectId: "project/one",
      taskId: created.id,
      title: "Done",
      description: "done body",
      status: "completed",
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: "Done",
      description: "done body",
      status: "completed",
    });
    expect(updated?.completedAt).toEqual(expect.any(String));

    await expect(store.delete({ projectId: "project/one", taskId: created.id })).resolves.toBe(
      true,
    );
    await expect(store.list("project/one")).resolves.toEqual([]);
    expect(existsSync(assetPath)).toBe(false);
  });

  it("does not update, delete, or expose attachments for the wrong project", async () => {
    const paseoHome = makePaseoHome();
    const store = new TaskStore(paseoHome);
    const uploadPath = writeUploadedFile(paseoHome, "upload-task-1", "notes.md", "hello");
    const created = await store.create({
      projectId: "project/one",
      title: "First task",
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

    await expect(
      store.update({
        projectId: "project/two",
        taskId: created.id,
        title: "Wrong project",
      }),
    ).resolves.toBeNull();
    await expect(
      store.getAttachment({
        projectId: "project/two",
        taskId: created.id,
        attachmentId: created.attachments[0]?.id ?? "",
      }),
    ).resolves.toBeNull();
    await expect(store.delete({ projectId: "project/two", taskId: created.id })).resolves.toBe(
      false,
    );

    await expect(store.list("project/one")).resolves.toMatchObject([
      {
        id: created.id,
        title: "First task",
        attachments: [{ fileName: "notes.md" }],
      },
    ]);
  });

  it("lists tasks for the requested active project ids without exposing attachment paths", async () => {
    const paseoHome = makePaseoHome();
    const store = new TaskStore(paseoHome);
    const uploadPath = writeUploadedFile(paseoHome, "upload-task-1", "notes.md", "hello");
    const projectOne = await store.create({
      projectId: "project/one",
      title: "Project one",
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
    await store.create({
      projectId: "project/two",
      title: "Project two",
      description: "",
      uploads: [],
    });

    const tasks = await store.listAll(new Set(["project/one"]));

    expect(tasks).toMatchObject([
      {
        id: projectOne.id,
        projectId: "project/one",
        title: "Project one",
        attachments: [{ fileName: "notes.md" }],
      },
    ]);
    expect(Object.hasOwn(tasks[0]?.attachments[0] ?? {}, "absolutePath")).toBe(false);
  });

  it("rejects forged upload paths outside the upload staging directory", async () => {
    const paseoHome = makePaseoHome();
    const store = new TaskStore(paseoHome);
    const forgedPath = join(paseoHome, "secret.txt");
    writeFileSync(forgedPath, "secret");

    await expect(
      store.create({
        projectId: "project/one",
        title: "Bad task",
        description: "",
        uploads: [
          {
            type: "uploaded_file",
            id: "upload-task-1",
            fileName: "secret.txt",
            mimeType: "text/plain",
            size: 6,
            path: forgedPath,
          },
        ],
      }),
    ).rejects.toThrow("outside the upload staging directory");
    expect(readFileSync(forgedPath, "utf8")).toBe("secret");
    await expect(store.list("project/one")).resolves.toEqual([]);
  });

  it("removes already-imported assets when a later attachment import fails", async () => {
    const paseoHome = makePaseoHome();
    const store = new TaskStore(paseoHome);
    const firstPath = writeUploadedFile(paseoHome, "upload-task-1", "first.txt", "first");
    const forgedPath = join(paseoHome, "outside.txt");
    writeFileSync(forgedPath, "outside");

    await expect(
      store.create({
        projectId: "project/one",
        title: "Partial task",
        description: "",
        uploads: [
          {
            type: "uploaded_file",
            id: "upload-task-1",
            fileName: "first.txt",
            mimeType: "text/plain",
            size: 5,
            path: firstPath,
          },
          {
            type: "uploaded_file",
            id: "upload-task-2",
            fileName: "outside.txt",
            mimeType: "text/plain",
            size: 7,
            path: forgedPath,
          },
        ],
      }),
    ).rejects.toThrow("outside the upload staging directory");

    await expect(store.list("project/one")).resolves.toEqual([]);
    expect(listFiles(join(paseoHome, "tasks", "assets"))).toEqual([]);
    expect(readFileSync(forgedPath, "utf8")).toBe("outside");
  });
});

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "task-store-test-")));
  tempDirs.push(root);
  return root;
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

function readPersistedPayload(paseoHome: string): {
  tasks: Array<{ attachments: Array<{ absolutePath: string }> }>;
} {
  return JSON.parse(readFileSync(join(paseoHome, "tasks", "tasks.json"), "utf8"));
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
      continue;
    }
    files.push(path);
  }
  return files.sort();
}
