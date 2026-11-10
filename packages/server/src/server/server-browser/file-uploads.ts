import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** What one answer to a file chooser may carry; the WebSocket's limit is 100 MB of base64. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface UploadedFile {
  name: string;
  /** Base64 of the file's bytes. */
  dataBase64: string;
}

/**
 * The files a viewer picked for a page's file chooser, written where the browser can read them:
 * `<root>/<browserId>/<answer>/<name>`, on the daemon's host. The tab's folder goes when the tab
 * does. Returns the paths in the order given.
 */
export async function writeUploads(
  root: string,
  browserId: string,
  files: readonly UploadedFile[],
): Promise<string[]> {
  const bytes = files.map((file) => Buffer.from(file.dataBase64, "base64"));
  const total = bytes.reduce((sum, file) => sum + file.byteLength, 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new Error(
      `The files come to ${Math.ceil(total / 1024 / 1024)} MB; the server browser takes up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per upload.`,
    );
  }
  const dir = join(root, browserId, randomUUID());
  await mkdir(dir, { recursive: true });
  const used = new Set<string>();
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const name = uniqueName(safeName(file.name), used);
    const path = join(dir, name);
    await writeFile(path, bytes[index]!);
    paths.push(path);
  }
  return paths;
}

export async function removeUploads(root: string, browserId: string): Promise<void> {
  await rm(join(root, browserId), { recursive: true, force: true });
}

/** The page sees the file's own name; it never names a place outside the folder. */
function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).split("\u0000").join("").trim();
  return base && base !== "." && base !== ".." ? base : "file";
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let copy = 2; used.has(candidate); copy++) candidate = `${copy}-${name}`;
  used.add(candidate);
  return candidate;
}
