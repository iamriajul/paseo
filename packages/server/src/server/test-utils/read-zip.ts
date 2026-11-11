import { inflateRawSync } from "node:zlib";

export interface ZipEntryContent {
  name: string;
  /** null for a directory entry. */
  content: Buffer | null;
}

/**
 * Reads a zip through its central directory, independently of the library that wrote it, so a
 * test can assert what an archive holds. Supports stored and deflated entries without Zip64,
 * which is enough for test fixtures.
 */
export function readZipEntries(zip: Buffer): ZipEntryContent[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Not a zip: end of central directory missing");
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntryContent[] = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad central directory entry");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) {
      entries.push({ name, content: null });
      continue;
    }
    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, content: method === 8 ? inflateRawSync(data) : Buffer.from(data) });
  }
  return entries;
}
