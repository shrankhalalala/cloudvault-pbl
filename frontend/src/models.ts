export type FileStatus = "pending" | "active" | "deleted";
export interface FileRecord {
  id: string;
  name: string;
  contentType: string;
  size: number;
  folderId: string | null;
  status: FileStatus;
  createdAt: string;
  updatedAt: string;
  sample?: boolean;
  processingState?: string;
  currentVersionId?: string | null;
}
export interface Version {
  versionId: string;
  size: number;
  createdAt: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
}
export interface StoredVersion extends Version {
  blob: Blob | null;
}
export interface Folder {
  id: string;
  name: string;
}
export interface Activity {
  id: string;
  fileId?: string;
  fileName: string;
  action: string;
  createdAt: string;
}
export interface Share {
  id: string;
  fileId: string;
  fileName: string;
  url: string;
  versionId: string;
  expiresAt: string;
  createdAt: string;
}
export interface DemoState {
  files: FileRecord[];
  versions: Record<string, StoredVersion[]>;
  folders: Folder[];
  activity: Activity[];
  shares: Share[];
}
export interface StateStore {
  read(): Promise<DemoState | undefined>;
  write(state: DemoState): Promise<void>;
}
export interface Analytics {
  count: number;
  bytes: number;
  retainedBytes: number;
  retainedVersions: number;
  deleted: number;
  byType: { type: string; bytes: number; count: number }[];
}

export type WorkspaceSnapshot = Omit<DemoState, "versions"> & {
  versions: Record<string, Version[]>;
  stats?: Analytics;
};
