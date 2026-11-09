import { expect, test } from "../support/fixtures";

// Fork composer-draft-sync: drafts saved on the worker daemon must not outlive the test that
// saved them. The second test runs after the first on the same worker daemon.
test.describe.configure({ mode: "serial" });

test.describe("Saved host drafts", () => {
  test("a test can leave saved drafts behind", async ({ e2eWorkerClient }) => {
    const updatedAt = new Date().toISOString();
    await e2eWorkerClient.upsertUiState({
      namespace: "composer",
      key: "new-workspace",
      record: { text: "Draft from an earlier test", lifecycle: "active", updatedAt },
    });
    await e2eWorkerClient.upsertUiState({
      namespace: "review",
      key: "review:earlier-test",
      record: { comments: [], updatedAt },
    });
  });

  test("the next test starts with none", async ({ e2eWorkerClient }) => {
    for (const namespace of ["composer", "review"] as const) {
      const { entries } = await e2eWorkerClient.listUiState({ namespace });
      expect(entries.map((entry) => entry.key)).toEqual([]);
    }
  });
});
