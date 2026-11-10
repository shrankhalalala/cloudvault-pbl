import { describe, it, expect, beforeEach } from "vitest";
import { DemoApi, analytics, MAX_BYTES, seedState } from "./demo-api";
import type { DemoState, StateStore } from "./models";
class MemoryStore implements StateStore {
  state: DemoState | undefined;
  fail = false;
  async read() {
    return structuredClone(this.state);
  }
  async write(state: DemoState) {
    if (this.fail) throw new Error("Quota exceeded");
    this.state = structuredClone(state);
  }
}
let api: DemoApi, store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  api = new DemoApi(store);
});
describe("persistent local demo API", () => {
  it("computes all active totals from actual blobs", async () => {
    const s = await api.snapshot();
    const a = analytics(s);
    expect(a.count).toBe(s.files.length);
    expect(a.bytes).toBe(s.files.reduce((n, f) => n + f.size, 0));
    for (const f of s.files)
      expect(s.versions[f.id][0].blob?.size).toBe(f.size);
    expect(a.byType.reduce((n, t) => n + t.bytes, 0)).toBe(a.bytes);
  });
  it("stores original upload bytes and survives a service restart", async () => {
    const file = new File(["original bytes"], "test.txt", {
      type: "text/plain",
    });
    const f = await api.upload(file, null, () => {});
    const restarted = new DemoApi(store);
    const content = await restarted.download(f.id);
    expect(await content.blob.text()).toBe("original bytes");
  });
  it("rejects invalid file size, MIME type, names, and folders", async () => {
    await expect(
      api.upload(
        new File([], "empty.txt", { type: "text/plain" }),
        null,
        () => {},
      ),
    ).rejects.toThrow("nonempty");
    await expect(
      api.upload(
        new File([new Uint8Array(MAX_BYTES + 1)], "large.txt", {
          type: "text/plain",
        }),
        null,
        () => {},
      ),
    ).rejects.toThrow("5 MB");
    await expect(
      api.upload(
        new File(["x"], "script.html", { type: "text/html" }),
        null,
        () => {},
      ),
    ).rejects.toThrow("Supported");
    const f = (await api.snapshot()).files[0];
    await expect(api.patch(f.id, { name: "../bad" })).rejects.toThrow(
      "valid filename",
    );
    await expect(api.patch(f.id, { folderId: "unknown" })).rejects.toThrow(
      "Folder not found",
    );
  });
  it("restores retained content after a delete marker without deleting history", async () => {
    const s = await api.snapshot(),
      f = s.files[0],
      v = s.versions[f.id][1];
    await api.remove(f.id);
    await expect(api.download(f.id)).rejects.toThrow("Restore");
    const deleted = await api.snapshot();
    expect(deleted.versions[f.id][0].isDeleteMarker).toBe(true);
    await expect(
      api.restore(f.id, deleted.versions[f.id][0].versionId),
    ).rejects.toThrow("Delete markers");
    await api.restore(f.id, v.versionId);
    const restored = await api.snapshot();
    expect(restored.files[0].status).toBe("active");
    expect(restored.versions[f.id].filter((x) => x.isLatest)).toHaveLength(1);
    expect(restored.versions[f.id][0].versionId).not.toBe(v.versionId);
    expect(await (await api.download(f.id)).blob.text()).toBe(
      await v.blob!.text(),
    );
  });
  it("does not commit in-memory changes when browser persistence fails", async () => {
    const s = await api.snapshot(),
      f = s.files[0];
    store.fail = true;
    await expect(api.patch(f.id, { name: "unsaved.txt" })).rejects.toThrow(
      "Quota",
    );
    expect((await api.snapshot()).files[0].name).toBe(f.name);
  });
  it("serializes concurrent changes rather than dropping one", async () => {
    const s = await api.snapshot();
    await Promise.all([
      api.patch(s.files[0].id, { name: "first.txt" }),
      api.patch(s.files[1].id, { name: "second.txt" }),
    ]);
    const next = await api.snapshot();
    expect(next.files[0].name).toBe("first.txt");
    expect(next.files[1].name).toBe("second.txt");
  });
  it("expires links and disallows sharing deleted files", async () => {
    const s = await api.snapshot(),
      f = s.files[0];
    const link = await api.share(f.id, 5, "http://localhost:5173");
    expect((await api.sharedDownload(link.id)).blob.size).toBe(f.size);
    store.state!.shares[0].expiresAt = new Date(0).toISOString();
    await expect(api.sharedDownload(link.id)).rejects.toThrow("expired");
    await api.remove(f.id);
    await expect(api.share(f.id, 15, "http://localhost:5173")).rejects.toThrow(
      "Restore",
    );
  });
  it("creates an honestly empty workspace when cleared", async () => {
    await api.reset(true);
    const s = await api.snapshot();
    expect(s.files).toHaveLength(0);
    expect(analytics(s).bytes).toBe(0);
    expect(seedState().files.length).toBeGreaterThan(0);
  });
});
