import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApi } from "./cloud-api";

const endpoint = "https://api.example.invalid";
const fileId = "5684087b-30c7-4833-899e-78ee1db00ea1";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

afterEach(() => vi.unstubAllGlobals());

describe("cloud workspace client", () => {
  it("uploads through S3 with signed headers and confirms through the authenticated API", async () => {
    const signedHeaders = {
      "Content-Type": "text/plain",
      "If-None-Match": "*",
      "x-amz-server-side-encryption": "AES256",
      "x-amz-expected-bucket-owner": "123456789012",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            file: { id: fileId, status: "pending" },
            uploadUrl: "https://bucket.s3.example.invalid/staging",
            requiredHeaders: signedHeaders,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(json({ file: { id: fileId, status: "active" } }));
    vi.stubGlobal("fetch", fetcher);
    const open = vi.fn();
    const setRequestHeader = vi.fn();
    class UploadRequest {
      status = 200;
      open = open;
      setRequestHeader = setRequestHeader;
      upload: {
        onprogress?: (event: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void;
      } = {};
      onload?: () => void;
      send(body: File) {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: body.size,
          total: body.size,
        });
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    const progress = vi.fn();
    const client = new CloudApi(endpoint, "access-token", vi.fn());
    await client.upload(
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      null,
      progress,
    );
    expect(open).toHaveBeenCalledWith(
      "PUT",
      "https://bucket.s3.example.invalid/staging",
    );
    expect(setRequestHeader.mock.calls).toEqual(Object.entries(signedHeaders));
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      endpoint + "/files/upload-url",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      endpoint + "/files/confirm-upload",
      expect.objectContaining({
        body: JSON.stringify({ fileId }),
      }),
    );
    expect(progress.mock.calls.flat()).toEqual([90, 95, 100]);
  });

  it("reuses the restore key after an ambiguous failure", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(json({ file: { id: fileId } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new CloudApi(endpoint, "access-token", vi.fn());
    await expect(client.restore(fileId, "opaque+/=")).rejects.toThrow(
      "Could not reach CloudVault",
    );
    await client.restore(fileId, "opaque+/=");
    const first = fetcher.mock.calls[0][1];
    const second = fetcher.mock.calls[1][1];
    expect(first.headers["Idempotency-Key"]).toEqual(
      second.headers["Idempotency-Key"],
    );
    expect(second.body).toEqual(JSON.stringify({ versionId: "opaque+/=" }));
  });

  it("surfaces unauthorized cloud errors and expires the in-memory session", async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        json(
          {
            error: { code: "UNAUTHORIZED", message: "Sign in again." },
          },
          401,
        ),
      ),
    );
    const client = new CloudApi(endpoint, "expired", onUnauthorized);
    await expect(client.download(fileId)).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("loads paginated files and displays only server usage", async () => {
    const emptyPage = { items: [], nextCursor: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/files") {
          return parsed.searchParams.has("cursor")
            ? json({ items: [{ id: "second" }], nextCursor: null })
            : json({ items: [{ id: "first" }], nextCursor: "opaque+" });
        }
        if (parsed.pathname === "/analytics")
          return json({
            fileCount: 2,
            totalSize: 40,
            deletedCount: 0,
            retainedVersionCount: 3,
            retainedBytes: 60,
            types: [
              { contentType: "text/plain", count: 1, size: 20 },
              { contentType: "application/json", count: 1, size: 20 },
            ],
          });
        return json(emptyPage);
      }),
    );
    const result = await new CloudApi(
      endpoint,
      "access-token",
      vi.fn(),
    ).snapshot();
    expect(result.files.map((file) => file.id)).toEqual(["first", "second"]);
    expect(result.stats?.byType).toEqual([
      { type: "Documents", count: 2, bytes: 40 },
    ]);
    expect(result.stats?.retainedBytes).toEqual(60);
    expect(result.versions).toEqual({});
  });
});

it("requests a specific opaque historical version", async () => {
  const versionId = "opaque+/= &";
  const fetcher = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/files/${fileId}/download`);
    expect(parsed.searchParams.get("versionId")).toBe(versionId);
    return json({
      url: "https://bucket.s3.example.invalid/",
      versionId,
      expiresIn: 300,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await new CloudApi(endpoint, "token", vi.fn()).download(fileId, versionId))
      .versionId,
  ).toBe(versionId);
});
