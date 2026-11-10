import type {
  Activity,
  Analytics,
  DemoState,
  FileRecord,
  StateStore,
  WorkspaceSnapshot,
} from "./models";
export const MAX_BYTES = 5 * 1024 * 1024;
export const ALLOWED = [
  "text/plain",
  "text/csv",
  "application/pdf",
  "application/json",
  "image/png",
  "image/jpeg",
];
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
export const fileKind = (type: string) =>
  type.startsWith("image/")
    ? "Images"
    : type === "application/pdf"
      ? "PDF documents"
      : type === "text/csv"
        ? "Spreadsheets"
        : "Documents";
export function seedState(): DemoState {
  const folders = [
    { id: id(), name: "Project documents" },
    { id: id(), name: "Research" },
    { id: id(), name: "Presentations" },
  ];
  const specs = [
    ["Architecture notes.txt", "text/plain", 0],
    ["Demo checklist.txt", "text/plain", 0],
    ["Storage research.csv", "text/csv", 1],
    ["Presentation outline.txt", "text/plain", 2],
    ["Cloud services.json", "application/json", 1],
    ["Recovery exercise.txt", "text/plain", 0],
  ] as const;
  const state: DemoState = {
    files: [],
    versions: {},
    folders,
    activity: [],
    shares: [],
  };
  specs.forEach(([name, contentType, folder], i) => {
    const createdAt = new Date(
      Date.now() - (specs.length - i) * 86400000,
    ).toISOString();
    const text =
      contentType === "application/json"
        ? JSON.stringify(
            { demo: true, services: ["S3", "Lambda", "DynamoDB"] },
            null,
            2,
          )
        : contentType === "text/csv"
          ? "Demo sample,Service,Purpose\ntrue,S3,Versioned object storage\ntrue,Lambda,Event processing\n"
          : `CLOUDVAULT — LOCAL DEMO SAMPLE\n${name}\n\nThis is a sample document for the university cloud storage project.\nNo AWS resources are connected. Replace this file with your own upload.\n`;
    const blob = new Blob([text], { type: contentType });
    const f: FileRecord = {
      id: id(),
      name,
      contentType,
      size: blob.size,
      folderId: folders[folder].id,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      sample: true,
    };
    state.files.push(f);
    state.versions[f.id] = [
      {
        versionId: id(),
        blob,
        size: blob.size,
        createdAt,
        isLatest: true,
        isDeleteMarker: false,
      },
    ];
    state.activity.unshift({
      id: id(),
      fileId: f.id,
      fileName: name,
      action: "Sample added",
      createdAt,
    });
  });
  const f = state.files[0],
    previous = new Blob(["CLOUDVAULT DEMO — Earlier architecture draft."], {
      type: f.contentType,
    });
  state.versions[f.id].push({
    versionId: id(),
    blob: previous,
    size: previous.size,
    createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
    isLatest: false,
    isDeleteMarker: false,
  });
  return state;
}
export class IndexedStore implements StateStore {
  private db?: Promise<IDBDatabase>;
  private open() {
    return (this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("cloudvault-demo-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "Local storage is unavailable. Allow browser storage and retry.",
          ),
        );
    }));
  }
  async read() {
    const db = await this.open();
    return new Promise<DemoState | undefined>((resolve, reject) => {
      const req = db
        .transaction("workspace")
        .objectStore("workspace")
        .get("state");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(new Error("Could not read local demo storage."));
    });
  }
  async write(state: DemoState) {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("workspace", "readwrite");
      tx.objectStore("workspace").put(state, "state");
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new Error(
            "Could not save this change. Browser storage may be full. Free space and retry.",
          ),
        );
      tx.onabort = () =>
        reject(new Error("Local save failed. No change was committed."));
    });
  }
}
export class DemoApi {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: StateStore) {}
  async snapshot() {
    await this.queue.catch(() => {});
    let state = await this.store.read();
    if (!state) {
      state = seedState();
      await this.store.write(state);
    }
    return structuredClone(state);
  }
  private change<T>(fn: (state: DemoState) => T): Promise<T> {
    const run = this.queue
      .catch(() => {})
      .then(async () => {
        let state = (await this.store.read()) ?? seedState();
        state = structuredClone(state);
        const result = fn(state);
        await this.store.write(state);
        return result;
      });
    this.queue = run;
    return run;
  }
  private record(s: DemoState, f: FileRecord, action: string) {
    const a: Activity = {
      id: id(),
      fileId: f.id,
      fileName: f.name,
      action,
      createdAt: now(),
    };
    s.activity.unshift(a);
    s.activity = s.activity.slice(0, 500);
  }
  private file(s: DemoState, fileId: string) {
    const f = s.files.find((f) => f.id === fileId);
    if (!f) throw new Error("File not found. Refresh your workspace.");
    return f;
  }
  async upload(
    file: File,
    folderId: string | null,
    onProgress: (n: number) => void,
  ) {
    if (file.size === 0 || file.size > MAX_BYTES)
      throw new Error("Choose a nonempty file up to 5 MB.");
    if (!ALLOWED.includes(file.type))
      throw new Error("Supported types: TXT, CSV, JSON, PDF, PNG and JPEG.");
    if (
      !file.name.trim() ||
      file.name.length > 180 ||
      /[\x00-\x1f/\\]/.test(file.name)
    )
      throw new Error(
        "Use a filename up to 180 characters without slashes or control characters.",
      );
    onProgress(15);
    await new Promise((r) => setTimeout(r, 120));
    onProgress(70);
    const result = await this.change((s) => {
      if (folderId && !s.folders.some((f) => f.id === folderId))
        throw new Error("Folder no longer exists.");
      const date = now();
      const f: FileRecord = {
        id: id(),
        name: file.name,
        contentType: file.type,
        size: file.size,
        folderId,
        status: "active",
        createdAt: date,
        updatedAt: date,
      };
      s.files.unshift(f);
      s.versions[f.id] = [
        {
          versionId: id(),
          blob: file,
          size: file.size,
          createdAt: date,
          isLatest: true,
          isDeleteMarker: false,
        },
      ];
      this.record(s, f, "Uploaded");
      return f;
    });
    onProgress(100);
    return result;
  }
  async patch(
    fileId: string,
    patch: { name?: string; folderId?: string | null },
  ) {
    return this.change((s) => {
      const f = this.file(s, fileId);
      if (f.status !== "active")
        throw new Error("Restore the file before editing.");
      if (patch.name !== undefined) {
        if (
          !patch.name.trim() ||
          patch.name.length > 180 ||
          /[\x00-\x1f/\\]/.test(patch.name)
        )
          throw new Error("Enter a valid filename up to 180 characters.");
        f.name = patch.name.trim();
      }
      if (patch.folderId !== undefined) {
        if (
          patch.folderId !== null &&
          !s.folders.some((f) => f.id === patch.folderId)
        )
          throw new Error("Folder not found.");
        f.folderId = patch.folderId;
      }
      f.updatedAt = now();
      this.record(s, f, patch.name !== undefined ? "Renamed" : "Moved");
    });
  }
  async folder(name: string) {
    return this.change((s) => {
      name = name.trim();
      if (!name || name.length > 80 || /[\x00-\x1f/\\]/.test(name))
        throw new Error(
          "Enter a folder name up to 80 characters without slashes.",
        );
      if (s.folders.some((f) => f.name.toLowerCase() === name.toLowerCase()))
        throw new Error("A folder with this name already exists.");
      s.folders.push({ id: id(), name });
    });
  }
  async remove(fileId: string) {
    return this.change((s) => {
      const f = this.file(s, fileId);
      if (f.status === "deleted") return;
      f.status = "deleted";
      f.updatedAt = now();
      s.versions[f.id].forEach((v) => (v.isLatest = false));
      s.versions[f.id].unshift({
        versionId: id(),
        size: 0,
        blob: null,
        createdAt: now(),
        isLatest: true,
        isDeleteMarker: true,
      });
      this.record(s, f, "Moved to trash");
    });
  }
  async restore(fileId: string, versionId: string) {
    return this.change((s) => {
      const f = this.file(s, fileId);
      const versions = s.versions[f.id];
      const source = versions.find((v) => v.versionId === versionId);
      if (!source || source.isDeleteMarker || !source.blob)
        throw new Error(
          "Choose a retained content version. Delete markers contain no file content.",
        );
      versions.forEach((v) => (v.isLatest = false));
      versions.unshift({
        ...source,
        versionId: id(),
        createdAt: now(),
        isLatest: true,
      });
      f.status = "active";
      f.size = source.size;
      f.updatedAt = now();
      this.record(s, f, "Version restored");
    });
  }
  async download(fileId: string, versionId?: string) {
    const s = await this.snapshot();
    const f = this.file(s, fileId);
    if (f.status !== "active")
      throw new Error("Restore this file before downloading.");
    const version = s.versions[fileId].find((v) =>
      versionId ? v.versionId === versionId : v.isLatest,
    );
    if (!version?.blob || version.isDeleteMarker)
      throw new Error("This version has no downloadable content.");
    await this.change((s) =>
      this.record(s, this.file(s, fileId), "Downloaded"),
    );
    return { blob: version.blob, name: f.name };
  }
  async share(fileId: string, minutes: number, origin: string) {
    return this.change((s) => {
      if (![1, 5, 15].includes(minutes))
        throw new Error("Select 1, 5 or 15 minutes.");
      const f = this.file(s, fileId);
      if (f.status !== "active")
        throw new Error("Restore the file before sharing.");
      const token = id();
      const share = {
        id: token,
        fileId,
        fileName: f.name,
        versionId: s.versions[fileId].find((v) => v.isLatest)!.versionId,
        url: `${origin}/#share/${token}`,
        createdAt: now(),
        expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
      };
      s.shares.unshift(share);
      this.record(s, f, "Demo link created");
      return share;
    });
  }
  async sharedDownload(token: string) {
    const s = await this.snapshot();
    const link = s.shares.find((l) => l.id === token);
    if (!link || Date.parse(link.expiresAt) <= Date.now())
      throw new Error(
        "This local demo link has expired or is unavailable in this browser.",
      );
    const f = this.file(s, link.fileId);
    if (f.status !== "active") throw new Error("This file is in trash.");
    const version = s.versions[f.id].find(
      (v) => v.versionId === link.versionId,
    );
    if (!version?.blob) throw new Error("The shared version is unavailable.");
    return { blob: version.blob, name: f.name };
  }
  async reset(empty = false) {
    return this.change((s) => {
      Object.assign(
        s,
        empty
          ? { files: [], versions: {}, folders: [], activity: [], shares: [] }
          : seedState(),
      );
    });
  }
}
export function analytics(s: WorkspaceSnapshot): Analytics {
  const files = s.files.filter((f) => f.status === "active");
  const versions = Object.values(s.versions)
    .flat()
    .filter((v) => !v.isDeleteMarker && !v.isLatest);
  const byType = Array.from(
    new Set(files.map((f) => fileKind(f.contentType))),
  ).map((type) => ({
    type,
    bytes: files
      .filter((f) => fileKind(f.contentType) === type)
      .reduce((n, f) => n + f.size, 0),
    count: files.filter((f) => fileKind(f.contentType) === type).length,
  }));
  return {
    count: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    retainedBytes: versions.reduce((n, v) => n + v.size, 0),
    retainedVersions: versions.length,
    deleted: s.files.filter((f) => f.status === "deleted").length,
    byType,
  };
}
export const api = new DemoApi(new IndexedStore());
