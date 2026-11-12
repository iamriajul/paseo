import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { Locator } from "@playwright/test";
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

async function seedShots(repoPath: string): Promise<void> {
  const shots = path.join(repoPath, "shots");
  await mkdir(shots, { recursive: true });
  // Name order is alpha, beta, gamma; the Markdown file between them is skipped.
  await writeFile(path.join(shots, "alpha.png"), solidPng(64, 40, [220, 60, 60]));
  await writeFile(path.join(shots, "beta.png"), solidPng(80, 40, [60, 160, 90]));
  await writeFile(path.join(shots, "between.md"), "# not an image\n", "utf8");
  await writeFile(path.join(shots, "gamma.png"), solidPng(96, 40, [60, 90, 220]));
}

/** A one-finger horizontal swipe across the middle of the element, as real touch events. */
async function swipe(target: Locator, direction: "left" | "right"): Promise<void> {
  const page = target.page();
  const box = await target.boundingBox();
  if (!box) throw new Error("Swipe target has no bounding box");
  const y = box.y + box.height / 2;
  const from = box.x + box.width * (direction === "left" ? 0.8 : 0.2);
  const to = box.x + box.width * (direction === "left" ? 0.2 : 0.8);
  const input = await page.context().newCDPSession(page);
  try {
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await input.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from + ((to - from) * step) / 8, y }],
      });
    }
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await input.detach();
  }
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

/** React's dev build logs this when paging renders two children under one key. */
function collectDuplicateKeyWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("same key")) warnings.push(message.text());
  });
  return warnings;
}

test.describe("Files image gallery", () => {
  test("pages through the folder's images with keys and buttons in one tab", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const duplicateKeyWarnings = collectDuplicateKeyWarnings(page);
    const workspace = await withWorkspace({ prefix: "files-image-gallery-" });
    await seedShots(workspace.repoPath);
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
    expect(duplicateKeyWarnings).toEqual([]);
  });
});

test.describe("Files image gallery on a phone", () => {
  // The workspace helpers need the desktop sidebar, so the image opens wide and the page then
  // narrows to a phone, which switches the app to its compact layout.
  test.use({ hasTouch: true });

  test("swipes between images, and a zoomed-in image does not page", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const duplicateKeyWarnings = collectDuplicateKeyWarnings(page);
    const workspace = await withWorkspace({ prefix: "files-image-gallery-phone-" });
    await seedShots(workspace.repoPath);
    await workspace.navigateTo();
    await openFileExplorer(page);
    await expandFolder(page, "shots");
    await openFileFromExplorer(page, "alpha.png");
    await expectShowing(page, "1 / 3", 64);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectShowing(page, "1 / 3", 64);
    const pager = visible(page, "image-gallery-slide-current");

    await test.step("the buttons show without hover", async () => {
      await expect(visible(page, "image-gallery-next-slot")).toHaveCSS("opacity", "1");
    });

    await test.step("a swipe past the first image stays on it", async () => {
      await swipe(pager, "right");
      await expectShowing(page, "1 / 3", 64);
    });

    await test.step("swiping left pages forward, swiping right pages back", async () => {
      await swipe(pager, "left");
      await expectShowing(page, "2 / 3", 80);
      await swipe(pager, "left");
      await expectShowing(page, "3 / 3", 96);
      await visible(page, "image-gallery").screenshot({
        path: test.info().outputPath("files-image-gallery-phone.png"),
      });
      await swipe(pager, "right");
      await expectShowing(page, "2 / 3", 80);
    });

    await test.step("a zoomed-in image pans instead of paging", async () => {
      // The toolbar is not under test; a click presses it reliably after synthetic touches.
      const toolbarButton = (name: string) =>
        page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
      const resetView = toolbarButton("Reset view");
      await toolbarButton("Zoom in").click();
      await expect(resetView).not.toHaveAttribute("aria-disabled", "true");
      await swipe(pager, "left");
      await expectShowing(page, "2 / 3", 80);
      await resetView.click();
      await expect(resetView).toHaveAttribute("aria-disabled", "true");
      await swipe(pager, "left");
      await expectShowing(page, "3 / 3", 96);
    });
    expect(duplicateKeyWarnings).toEqual([]);
  });
});
