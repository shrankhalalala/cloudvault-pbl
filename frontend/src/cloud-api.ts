import { ALLOWED, fileKind, MAX_BYTES } from "./demo-api";
import type {
  Activity,
  Analytics,
  FileRecord,
  Folder,
  Share,
  Version,
  WorkspaceSnapshot,
} from "./models";

type Page<T> = { items: T[]; nextCursor: string | null };
type AnalyticsResponse = {
  fileCount: number;
  totalSize: number;
  deletedCount: number;
  retainedVersionCount: number;
  retainedBytes: number;
  types: { contentType: string; count: number; size: number }[];
};
type UploadIntent = {
  file: FileRecord;
  uploadUrl: string | null;
  requiredHeaders: Record<string, string>;
};

export class CloudApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class CloudApi {
  private operationKeys = new Map<string, string>();

  constructor(
    private endpoint: string,
    private token: string,
    private onUnauthorized: () => void,
  ) {}

  private async request<T>(
    path: string,
    method = "GET",
    body?: object,
    operationKey?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(operationKey ? { "Idempotency-Key": operationKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new Error(
        "Could not reach CloudVault. Check your connection and retry.",
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) this.onUnauthorized();
      throw new CloudApiError(
        response.status,
        payload.error?.code ?? "API_ERROR",
        payload.error?.message ??
          `CloudVault request failed (${response.status}).`,
      );
    }
    return response.status === 204 ? (undefined as T) : response.json();
  }

  private async fileList() {
    const files: FileRecord[] = [];
    let cursor: string | null = null;
    // The API caps the complete workspace at 200 files. Use an extra page for
    // concurrent edits and reject unexpected pagination instead of looping.
    for (let i = 0; i < 3; i++) {
      const params = new URLSearchParams({ status: "all", limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const result: Page<FileRecord> = await this.request(`/files?${params}`);
      files.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor)
        return Array.from(new Map(files.map((f) => [f.id, f])).values());
    }
    throw new Error("The workspace changed while loading. Refresh and retry.");
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const [files, folders, activity, shares, usage] = await Promise.all([
      this.fileList(),
      this.request<Page<Folder>>("/folders?limit=100"),
      this.request<Page<Activity>>("/activity?limit=100"),
      this.request<Page<Share>>("/shares?limit=100"),
      this.request<AnalyticsResponse>("/analytics"),
    ]);
    const grouped = new Map<string, Analytics["byType"][number]>();
    for (const item of usage.types) {
      const type = fileKind(item.contentType);
      const group = grouped.get(type) ?? { type, bytes: 0, count: 0 };
      group.bytes += item.size;
      group.count += item.count;
      grouped.set(type, group);
    }
    return {
      files,
      folders: folders.items,
      activity: activity.items,
      shares: shares.items,
      versions: {},
      stats: {
        count: usage.fileCount,
        bytes: usage.totalSize,
        deleted: usage.deletedCount,
        retainedVersions: usage.retainedVersionCount,
        retainedBytes: usage.retainedBytes,
        byType: [...grouped.values()],
      },
    };
  }

  async upload(
    file: File,
    folderId: string | null,
    progress: (n: number) => void,
  ) {
    if (!file.size || file.size > MAX_BYTES || !ALLOWED.includes(file.type)) {
      throw new Error("Choose a supported nonempty file up to 5 MiB.");
    }
    const intent = await this.operation<UploadIntent>(
      "/files/upload-url",
      "POST",
      {
        name: file.name,
        contentType: file.type,
        size: file.size,
        folderId,
      },
    );
    try {
      if (intent.file.status === "active") {
        progress(100);
        return;
      }
      if (!intent.uploadUrl)
        throw new Error("CloudVault did not return an upload URL.");
      await uploadBytes(
        intent.uploadUrl,
        intent.requiredHeaders,
        file,
        progress,
      );
    } catch (error) {
      // The request can succeed even when its response is lost. Attempt
      // confirmation only for an ambiguous transport error or a replay.
      if (!(error instanceof CloudApiError) || ![0, 412].includes(error.status))
        throw error;
    }
    progress(95);
    try {
      await this.confirmUpload(intent.file.id);
    } catch (error) {
      if (
        !(error instanceof CloudApiError) ||
        !["OPERATION_IN_PROGRESS", "STATE_CONFLICT"].includes(error.code)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await this.confirmUpload(intent.file.id);
    }
    progress(100);
  }

  confirmUpload(fileId: string) {
    return this.request<{ file: FileRecord }>("/files/confirm-upload", "POST", {
      fileId,
    });
  }

  patch(id: string, data: { name?: string; folderId?: string | null }) {
    return this.request<{ file: FileRecord }>(`/files/${id}`, "PATCH", data);
  }

  folder(name: string) {
    return this.request<{ folder: Folder }>("/folders", "POST", { name });
  }

  async download(id: string, versionId?: string) {
    const suffix = versionId ? `?${new URLSearchParams({ versionId })}` : "";
    return this.request<{ url: string; expiresIn: number; versionId: string }>(
      `/files/${id}/download${suffix}`,
    );
  }

  versions(id: string, cursor: string | null = null) {
    const params = new URLSearchParams({ limit: "25" });
    if (cursor) params.set("cursor", cursor);
    return this.request<Page<Version>>(`/files/${id}/versions?${params}`);
  }

  private async operation<T>(path: string, method: string, body?: object) {
    const action = JSON.stringify([method, path, body]);
    const key = this.operationKeys.get(action) ?? crypto.randomUUID();
    this.operationKeys.set(action, key);
    try {
      const result = await this.request<T>(path, method, body, key);
      this.operationKeys.delete(action);
      return result;
    } catch (error) {
      if (
        error instanceof CloudApiError &&
        ([400, 401, 403, 404].includes(error.status) ||
          error.code === "UPLOAD_INTENT_EXPIRED")
      ) {
        this.operationKeys.delete(action);
      }
      throw error;
    }
  }

  remove(id: string) {
    return this.operation<void>(`/files/${id}`, "DELETE");
  }

  restore(id: string, versionId: string) {
    return this.operation<{ file: FileRecord }>(
      `/files/${id}/restore`,
      "POST",
      { versionId },
    );
  }

  share(id: string, minutes: number, _origin?: string) {
    return this.request<Share>(`/files/${id}/share`, "POST", {
      expiresIn: minutes * 60,
    });
  }
}

function uploadBytes(
  uploadUrl: string,
  headers: Record<string, string>,
  file: File,
  progress: (n: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const url = new URL(uploadUrl);
    if (url.protocol !== "https:") {
      reject(new Error("CloudVault requires a secure S3 upload URL."));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("PUT", url.href);
    request.timeout = 90_000;
    // The browser supplies the signed Content-Length for this File body.
    for (const [key, value] of Object.entries(headers))
      request.setRequestHeader(key, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.floor((90 * event.loaded) / event.total));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else
        reject(
          new CloudApiError(
            request.status,
            "S3_UPLOAD_FAILED",
            `S3 rejected the upload (${request.status}).`,
          ),
        );
    };
    request.onabort =
      request.onerror =
      request.ontimeout =
        () =>
          reject(
            new CloudApiError(
              0,
              "S3_UPLOAD_INTERRUPTED",
              "The upload connection was interrupted.",
            ),
          );
    request.send(file);
  });
}
