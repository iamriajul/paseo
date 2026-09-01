import { beforeEach, describe, expect, test, vi } from "vitest";

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(async () => {}),
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => null,
  isElectronRuntime: () => false,
}));
vi.mock("@/hooks/use-settings", () => ({
  loadAppSettingsFromStorage: vi.fn(),
  persistAppSettings: vi.fn(),
}));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: openExternalUrlMock }));

import { openServiceUrl } from "./open-service-url";

describe("openServiceUrl on native clients", () => {
  beforeEach(() => openExternalUrlMock.mockClear());

  test("uses an available workspace Browser", async () => {
    const openInApp = vi.fn(() => true);
    await openServiceUrl("http://localhost:3000", { openInApp });
    expect(openInApp).toHaveBeenCalledWith("http://localhost:3000");
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });

  test("falls back to the external browser when the workspace Browser declines", async () => {
    await openServiceUrl("http://localhost:3000", { openInApp: () => false });
    expect(openExternalUrlMock).toHaveBeenCalledWith("http://localhost:3000");
  });

  test("keeps void callbacks compatible", async () => {
    await openServiceUrl("https://example.com", { openInApp: () => {} });
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });
});
