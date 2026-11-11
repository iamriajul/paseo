import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "../support/fixtures";
import {
  expandFolder,
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";

/** A solid-colour RGB PNG, so each image in the folder is told apart by its pixels. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function visible(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true }).first();
}

async function expectShowing(page: Page, position: string, imageWidth: number) {
  await expect(visible(page, "image-gallery-position")).toHaveText(position);
  await expect
    .poll(() =>
      visible(page, "image-gallery")
        .locator("img")
        .first()
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(imageWidth);
}

test.describe("Files image gallery", () => {
  test("pages through the folder's images with keys and buttons in one tab", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "files-image-gallery-" });
    const shots = path.join(workspace.repoPath, "shots");
    await mkdir(shots, { recursive: true });
    // Name order is alpha, beta, gamma; the Markdown file between them is skipped.
    await writeFile(path.join(shots, "alpha.png"), solidPng(64, 40, [220, 60, 60]));
    await writeFile(path.join(shots, "beta.png"), solidPng(80, 40, [60, 160, 90]));
    await writeFile(path.join(shots, "between.md"), "# not an image\n", "utf8");
    await writeFile(path.join(shots, "gamma.png"), solidPng(96, 40, [60, 90, 220]));
    await workspace.navigateTo();
    await openFileExplorer(page);
    await expandFolder(page, "shots");
    await openFileFromExplorer(page, "alpha.png");
    await expectFileTabOpen(page, "shots/alpha.png");
    await expectShowing(page, "1 / 3", 64);

    const previous = visible(page, "image-gallery-previous");
    const next = visible(page, "image-gallery-next");
    const previousSlot = visible(page, "image-gallery-previous-slot");
    const nextSlot = visible(page, "image-gallery-next-slot");
    await test.step("the first image offers only Next", async () => {
      await visible(page, "image-gallery").hover();
      await expect(nextSlot).toHaveCSS("opacity", "1");
      await expect(previousSlot).toHaveCSS("opacity", "0");
    });

    await test.step("Right arrow pages forward past the Markdown file", async () => {
      await visible(page, "image-file-preview-canvas").click();
      await page.keyboard.press("ArrowRight");
      await expectShowing(page, "2 / 3", 80);
    });

    await test.step("Next pages to the last image, which offers only Previous", async () => {
      await next.click();
      await expectShowing(page, "3 / 3", 96);
      await expect(nextSlot).toHaveCSS("opacity", "0");
      await page.keyboard.press("ArrowRight");
      await expectShowing(page, "3 / 3", 96);
      await visible(page, "image-gallery").screenshot({
        path: test.info().outputPath("files-image-gallery-desktop.png"),
      });
    });

    await test.step("Left arrow and Previous page back", async () => {
      await page.keyboard.press("ArrowLeft");
      await expectShowing(page, "2 / 3", 80);
      await previous.click();
      await expectShowing(page, "1 / 3", 64);
    });

    await test.step("paging retargets the one file tab instead of opening more", async () => {
      await expect(page.locator('[data-testid^="workspace-tab-file_"]:visible')).toHaveCount(1);
      await expect(
        page.getByTestId("workspace-tab-file_shots/alpha.png").filter({ visible: true }),
      ).toContainText("alpha.png");
    });
  });
});
