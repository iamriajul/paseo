import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFolderZipStream, getDownloadableFolderInfo } from "./folder-zip.js";
import { readZipEntries } from "../test-utils/read-zip.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function zipFolder(root: string, relativePath: string, includeHidden = true) {
  const folder = await getDownloadableFolderInfo({ root, relativePath });
  const chunks: Buffer[] = [];
  const stream = createFolderZipStream(
    { ...folder, includeHidden },
    { signal: new AbortController().signal },
  );
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  const entries = readZipEntries(Buffer.concat(chunks));
  return {
    folder,
    files: Object.fromEntries(
      entries.map((entry) => [entry.name, entry.content?.toString("utf8") ?? null]),
    ),
  };
}

describe("folder zip", () => {
  test("zips the workspace root under a folder named after it", async () => {
    const parent = makeDir("folder-zip-");
    const root = path.join(parent, "my-project");
    mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    mkdirSync(path.join(root, "empty"));
    writeFileSync(path.join(root, "README.md"), "hello");
    writeFileSync(path.join(root, "src", "index.ts"), "export {};\n".repeat(1000));
    writeFileSync(path.join(root, "src", "nested", "deep.txt"), "deep");

    const { folder, files } = await zipFolder(root, ".");

    expect(folder.fileName).toBe("my-project.zip");
    expect(folder.path).toBe(".");
    expect(files).toEqual({
      "my-project/README.md": "hello",
      "my-project/empty/": null,
      "my-project/src/index.ts": "export {};\n".repeat(1000),
      "my-project/src/nested/deep.txt": "deep",
    });
  });

  test("zips a subfolder under its own name", async () => {
    const root = makeDir("folder-zip-");
    mkdirSync(path.join(root, "docs", "guides"), { recursive: true });
    writeFileSync(path.join(root, "docs", "guides", "a.md"), "a");
    writeFileSync(path.join(root, "outside-the-subfolder.txt"), "no");

    const { folder, files } = await zipFolder(root, "docs/guides");

    expect(folder).toMatchObject({ path: "docs/guides", fileName: "guides.zip" });
    expect(files).toEqual({ "guides/a.md": "a" });
  });

  test("leaves dot-named entries out only when hidden files are hidden", async () => {
    const root = makeDir("folder-zip-");
    mkdirSync(path.join(root, ".config"));
    writeFileSync(path.join(root, ".config", "x"), "x");
    writeFileSync(path.join(root, ".env"), "secret");
    writeFileSync(path.join(root, "visible.txt"), "v");
    const name = path.basename(root);

    expect(Object.keys((await zipFolder(root, ".", false)).files)).toEqual([`${name}/visible.txt`]);
    expect(Object.keys((await zipFolder(root, ".", true)).files).sort()).toEqual(
      [`${name}/.config/x`, `${name}/.env`, `${name}/visible.txt`].sort(),
    );
  });

  test("follows file symlinks inside the workspace and skips every other link", async () => {
    const outside = makeDir("folder-zip-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    const root = makeDir("folder-zip-");
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "target.txt"), "target");
    symlinkSync(path.join(root, "target.txt"), path.join(root, "sub", "inside-link.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "sub", "outside-link.txt"));
    symlinkSync(outside, path.join(root, "sub", "outside-dir"));
    symlinkSync(root, path.join(root, "sub", "loop"));
    symlinkSync(path.join(root, "missing"), path.join(root, "sub", "dangling"));

    const { files } = await zipFolder(root, "sub");

    expect(files).toEqual({ "sub/inside-link.txt": "target" });
  });

  test("refuses a folder reached through a symlink that leaves the workspace", async () => {
    const outside = makeDir("folder-zip-outside-");
    const root = makeDir("folder-zip-");
    symlinkSync(outside, path.join(root, "escape"));

    await expect(getDownloadableFolderInfo({ root, relativePath: "escape" })).rejects.toThrow(
      "Access outside of workspace is not allowed",
    );
    await expect(getDownloadableFolderInfo({ root, relativePath: "../" })).rejects.toThrow(
      "Access outside of workspace is not allowed",
    );
  });

  test("refuses a file path", async () => {
    const root = makeDir("folder-zip-");
    writeFileSync(path.join(root, "file.txt"), "f");

    await expect(getDownloadableFolderInfo({ root, relativePath: "file.txt" })).rejects.toThrow(
      "Requested path is not a folder",
    );
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips unreadable entries and FIFOs instead of failing the zip",
    async () => {
      const root = makeDir("folder-zip-");
      writeFileSync(path.join(root, "ok.txt"), "ok");
      writeFileSync(path.join(root, "locked.txt"), "locked");
      chmodSync(path.join(root, "locked.txt"), 0o000);
      mkdirSync(path.join(root, "locked-dir"));
      writeFileSync(path.join(root, "locked-dir", "inner.txt"), "inner");
      chmodSync(path.join(root, "locked-dir"), 0o000);
      execFileSync("mkfifo", [path.join(root, "pipe")]);
      const name = path.basename(root);

      try {
        const { files } = await zipFolder(root, ".");
        expect(files).toEqual({ [`${name}/ok.txt`]: "ok" });
      } finally {
        chmodSync(path.join(root, "locked-dir"), 0o755);
      }
    },
  );
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

async function zipError(root: string, relativePath: string): Promise<Error> {
  try {
    await zipFolder(root, relativePath);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the zip to fail");
}

/** Fails the first call whose path ends with `suffix`, then lets every call through. */
function failOnce<K extends "readdir" | "open" | "realpath">(
  method: K,
  suffix: string,
  error: NodeJS.ErrnoException,
) {
  const real = fsPromises[method].bind(fsPromises) as (...args: unknown[]) => Promise<unknown>;
  let failed = false;
  return vi.spyOn(fsPromises, method).mockImplementation(((...args: unknown[]) => {
    if (!failed && String(args[0]).endsWith(suffix)) {
      failed = true;
      return Promise.reject(error);
    }
    return real(...args);
  }) as never);
}

describe("folder zip under faults", () => {
  function fixture() {
    const root = makeDir("folder-zip-faults-");
    mkdirSync(path.join(root, "assets", "deep"), { recursive: true });
    writeFileSync(path.join(root, "assets", "deep", "données.txt"), "deep file");
    writeFileSync(path.join(root, "assets", "logo.svg"), "<svg/>");
    return root;
  }
  const complete = {
    "assets/deep/données.txt": "deep file",
    "assets/logo.svg": "<svg/>",
  };

  test("retries the folder's own listing when the host is out of descriptors", async () => {
    const root = fixture();
    failOnce("readdir", `${path.sep}assets`, fsError("EMFILE"));

    expect((await zipFolder(root, "assets")).files).toEqual(complete);
  });

  test("retries a subfolder's listing instead of leaving it out", async () => {
    const root = fixture();
    failOnce("readdir", `${path.sep}deep`, fsError("ENFILE"));

    expect((await zipFolder(root, "assets")).files).toEqual(complete);
  });

  test("retries opening a file instead of leaving it out", async () => {
    const root = fixture();
    failOnce("open", "logo.svg", fsError("EMFILE"));

    expect((await zipFolder(root, "assets")).files).toEqual(complete);
  });

  test("says the folder no longer exists when it vanished after the token was issued", async () => {
    const root = fixture();
    const folder = await getDownloadableFolderInfo({ root, relativePath: "assets" });
    rmSync(path.join(root, "assets"), { recursive: true });
    const stream = createFolderZipStream(
      { ...folder, includeHidden: true },
      { signal: new AbortController().signal },
    );

    await expect(stream.toArray()).rejects.toThrow('Could not read "assets": it no longer exists');
  });

  test("skips a file that vanishes between the listing and the open", async () => {
    const root = fixture();
    failOnce("realpath", "logo.svg", fsError("ENOENT"));

    expect((await zipFolder(root, "assets")).files).toEqual({
      "assets/deep/données.txt": "deep file",
    });
  });

  test("skips a subfolder that vanishes between the listing and its own listing", async () => {
    const root = fixture();
    failOnce("readdir", `${path.sep}deep`, fsError("ENOENT"));

    expect((await zipFolder(root, "assets")).files).toEqual({ "assets/logo.svg": "<svg/>" });
  });

  test("names the file when reading it fails partway", async () => {
    const root = fixture();
    const realOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation((async (
      ...args: Parameters<typeof realOpen>
    ) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith("logo.svg")) {
        handle.createReadStream = (() =>
          new Readable({
            read() {
              this.destroy(fsError("EIO"));
            },
          })) as never;
      }
      return handle;
    }) as never);

    expect((await zipError(root, "assets")).message).toBe(
      'Could not read "assets/logo.svg": EIO: injected',
    );
  });

  test("keeps a file whose name has a backslash as one entry", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "assets", "notes\\"), "trailing");
    writeFileSync(path.join(root, "assets", "a\\..\\b"), "dots");

    expect((await zipFolder(root, "assets")).files).toEqual({
      ...complete,
      "assets/a_.._b": "dots",
      "assets/notes_": "trailing",
    });
  });
});
