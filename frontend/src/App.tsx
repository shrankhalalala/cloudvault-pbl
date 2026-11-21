import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Modal, Metric, Vault, ActivityChart } from "./components";
import {
  LayoutDashboard,
  Files,
  Link,
  History,
  ChartNoAxesColumn,
  Settings,
  CloudUpload,
  Search,
  Folder,
  ArrowUpRight,
  ArrowDownToLine,
  MoreHorizontal,
  List,
  Grid2X2,
  Plus,
  ShieldCheck,
  Menu,
  X,
  FileText,
  Image,
  Trash2,
  RotateCcw,
  ChevronRight,
  Check,
  Copy,
} from "lucide-react";
import { api as demoApi, analytics, fileKind, MAX_BYTES } from "./demo-api";
import type { FileRecord, Version, WorkspaceSnapshot } from "./models";
import type { CloudApi } from "./cloud-api";
type Page =
  | "Dashboard"
  | "My Files"
  | "Shared Links"
  | "Recent Activity"
  | "Storage Analytics"
  | "Settings";
const nav = [
  { name: "Dashboard" as Page, icon: LayoutDashboard },
  { name: "My Files" as Page, icon: Files },
  { name: "Shared Links" as Page, icon: Link },
  { name: "Recent Activity" as Page, icon: History },
  { name: "Storage Analytics" as Page, icon: ChartNoAxesColumn },
  { name: "Settings" as Page, icon: Settings },
];
// URL fragments are user input; invalid percent escapes should not break navigation.
function currentPageFragment() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "Dashboard";
  }
}
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(2)} MB`;
const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
function save(result: { blob: Blob; name: string } | { url: string }) {
  const a = document.createElement("a");
  a.rel = "noreferrer";
  if ("url" in result) {
    a.href = result.url;
    a.click();
    return;
  }
  const url = URL.createObjectURL(result.blob);
  a.href = url;
  a.download = result.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App({
  cloud,
  onSignOut,
}: {
  cloud?: CloudApi;
  onSignOut?: () => void;
}) {
  const api = cloud ?? demoApi;
  const [page, setPage] = useState<Page>(() => {
    const hash = currentPageFragment();
    return nav.some((n) => n.name === hash) ? (hash as Page) : "Dashboard";
  });
  const [state, setState] = useState<WorkspaceSnapshot | null>(null),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [loading, setLoading] = useState(true),
    [mobile, setMobile] = useState(false),
    [query, setQuery] = useState(""),
    [folder, setFolder] = useState("all"),
    [type, setType] = useState("all"),
    [sort, setSort] = useState("updated"),
    [grid, setGrid] = useState(false),
    [trash, setTrash] = useState(false),
    [pending, setPending] = useState(false),
    [drag, setDrag] = useState(false),
    [progress, setProgress] = useState<number | null>(null),
    [uploadName, setUploadName] = useState(""),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ kind: string; file?: FileRecord }>(),
    [name, setName] = useState(""),
    [destination, setDestination] = useState(""),
    [minutes, setMinutes] = useState(15),
    [restore, setRestore] = useState(""),
    [shareUrl, setShareUrl] = useState(""),
    [shareToken, setShareToken] = useState(
      !cloud && location.hash.startsWith("#share/")
        ? location.hash.slice(7)
        : "",
    );
  const [versionPage, setVersionPage] = useState<{
    items: Version[];
    nextCursor: string | null;
  }>();
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState("");
  const versionFile = modal?.kind === "versions" ? modal.file?.id : undefined;
  useEffect(() => {
    if (!cloud || !versionFile) return;
    let current = true;
    setVersionPage(undefined);
    setVersionError("");
    setVersionLoading(true);
    void cloud
      .versions(versionFile)
      .then((result) => {
        if (current) setVersionPage(result);
      })
      .catch((error: Error) => {
        if (current) setVersionError(error.message);
      })
      .finally(() => {
        if (current) setVersionLoading(false);
      });
    return () => {
      current = false;
    };
  }, [cloud, versionFile]);

  const input = useRef<HTMLInputElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    const getControls = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, [tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0);
    getControls()[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobile(false);
      }
      if (event.key === "Tab") {
        const controls = getControls(),
          first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [mobile]);
  useEffect(() => {
    const nextExpiry = state?.shares
      .map((s) => Date.parse(s.expiresAt))
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0];
    if (!nextExpiry) return;
    const timer = setTimeout(
      () => setState((current) => (current ? { ...current } : current)),
      nextExpiry - Date.now() + 20,
    );
    return () => clearTimeout(timer);
  }, [state]);
  async function refresh() {
    setLoading(true);
    try {
      setState(await api.snapshot());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const handle = () => {
      if (!cloud && location.hash.startsWith("#share/")) {
        setShareToken(location.hash.slice(7));
        return;
      }
      setShareToken("");
      const p = currentPageFragment();
      if (nav.some((n) => n.name === p)) setPage(p as Page);
    };
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, [api, cloud]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const go = (p: Page) => {
    setPage(p);
    location.hash = encodeURIComponent(p);
    setMobile(false);
    setQuery("");
    if (p !== "My Files") setPending(false);
  };
  async function run(
    action: () => Promise<unknown>,
    message: string,
    close = true,
    refreshWorkspace = true,
  ) {
    setBusy(true);
    setError("");
    try {
      await action();
      if (refreshWorkspace) setState(await api.snapshot());
      setToast(message);
      if (close) setModal(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setUploadName(file.name);
      setProgress(0);
      try {
        await api.upload(file, folder === "all" ? null : folder, setProgress);
        setState(await api.snapshot());
        setToast(
          cloud
            ? `${file.name} uploaded`
            : `${file.name} saved to this browser`,
        );
      } catch (e) {
        setError((e as Error).message);
        if (cloud) {
          try {
            setState(await api.snapshot());
          } catch {
            /* Keep the original upload error. */
          }
        }
        break;
      }
    }
    setProgress(null);
    if (input.current) input.current.value = "";
  }
  function open(kind: string, file?: FileRecord) {
    setError("");
    setModal({ kind, file });
    setName(kind === "rename" ? (file?.name ?? "") : "");
    setDestination(file?.folderId ?? "");
    setShareUrl("");
    setRestore("");
  }
  if (shareToken)
    return (
      <main className="share-screen">
        <div className="brand">
          <Vault />
          CloudVault
        </div>
        <span className="demo-tag">Local demo link</span>
        <h1>A file has been shared with you</h1>
        <p>
          This simulation works only in the browser and origin where the link
          was created. It is not an S3 link.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(
              async () => save(await demoApi.sharedDownload(shareToken)),
              "Download started",
              false,
            )
          }
        >
          <ArrowDownToLine size={16} />
          Download shared file
        </button>
        <button
          onClick={() => {
            location.hash = "Dashboard";
            setShareToken("");
          }}
        >
          Open workspace
        </button>
      </main>
    );
  const a = state ? (state.stats ?? analytics(state)) : null;
  const files =
    state?.files
      .filter(
        (f) =>
          f.status === (pending ? "pending" : trash ? "deleted" : "active") &&
          f.name.toLowerCase().includes(query.toLowerCase()) &&
          (folder === "all" || f.folderId === folder) &&
          (type === "all" || fileKind(f.contentType) === type),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : sort === "size"
            ? b.size - a.size
            : b.updatedAt.localeCompare(a.updatedAt),
      ) ?? [];
  const close = () => {
    setModal(undefined);
    setError("");
  };
  const actions = (file: FileRecord) => (
    <details className="actions">
      <summary aria-label={`Actions for ${file.name}`}>
        <MoreHorizontal size={20} />
      </summary>
      <div>
        {file.status === "active" && (
          <>
            <button
              onClick={() =>
                void run(
                  async () => save(await api.download(file.id)),
                  "Download started",
                  false,
                  false,
                )
              }
            >
              <ArrowDownToLine size={15} />
              Download
            </button>
            <button onClick={() => open("rename", file)}>Rename</button>
            <button onClick={() => open("move", file)}>Move to folder</button>
            <button onClick={() => open("share", file)}>
              <Link size={15} />
              {cloud ? "Create download link" : "Create demo link"}
            </button>
          </>
        )}
        {file.status === "pending" && cloud ? (
          <button
            disabled={busy}
            onClick={() =>
              void run(
                () => cloud.confirmUpload(file.id),
                "Upload confirmed",
                false,
              )
            }
          >
            Confirm upload
          </button>
        ) : (
          <button onClick={() => open("versions", file)}>
            <History size={15} /> Version history
          </button>
        )}
        {file.status === "active" && (
          <button className="danger" onClick={() => open("delete", file)}>
            <Trash2 size={15} />
            Move to trash
          </button>
        )}
      </div>
    </details>
  );
  const fileTable = (rows: FileRecord[]) =>
    rows.length ? (
      <div className={grid && page === "My Files" ? "file-grid" : "file-table"}>
        <div className="table-head">
          <span>Name</span>
          <span>Folder</span>
          <span className="number">Size</span>
          <span>Last modified</span>
          <span />
        </div>
        {rows.map((f) => (
          <article className="file-row" key={f.id}>
            <div className="file-identity">
              {f.contentType.startsWith("image/") ? (
                <Image size={21} />
              ) : (
                <FileText size={21} />
              )}
              <div>
                <button
                  className="file-name"
                  onClick={() =>
                    f.status === "pending" && cloud
                      ? void run(
                          () => cloud.confirmUpload(f.id),
                          "Upload confirmed",
                          false,
                        )
                      : open("versions", f)
                  }
                >
                  {f.name}
                </button>
                <small>
                  {f.sample ? "Demo sample" : fileKind(f.contentType)}
                  {f.status === "deleted" ? " · In trash" : ""}
                  {f.status === "pending" ? " · Awaiting confirmation" : ""}
                  {f.processingState?.endsWith("InProgress")
                    ? " · Processing"
                    : ""}
                  {f.processingState === "rejected"
                    ? " · Verification rejected"
                    : ""}
                  {f.processingState === "stale"
                    ? " · Check version history"
                    : ""}
                </small>
              </div>
            </div>
            <span className="folder-label">
              {state?.folders.find((x) => x.id === f.folderId)?.name ??
                "Unfiled"}
            </span>
            <span className="number file-size">{size(f.size)}</span>
            <time>{date(f.updatedAt)}</time>
            {actions(f)}
          </article>
        ))}
      </div>
    ) : (
      <div className="empty">
        <Files size={26} />
        <h3>{trash ? "Trash is empty" : "No files in this view"}</h3>
        <p>
          {query || folder !== "all" || type !== "all"
            ? "Try another search or clear your filters."
            : "Upload your first file to get started."}
        </p>
        {!trash && (
          <button onClick={() => input.current?.click()}>Upload a file</button>
        )}
      </div>
    );
  const activity = (limit?: number) => (
    <div className="activity-list">
      {state?.activity.slice(0, limit).map((item) => (
        <article key={item.id}>
          <span className="activity-symbol">
            {item.action.includes("restored") ? (
              <RotateCcw size={16} />
            ) : item.action.includes("link") ? (
              <Link size={16} />
            ) : (
              <History size={16} />
            )}
          </span>
          <div>
            <strong>{item.action}</strong>
            <p>{item.fileName}</p>
          </div>
          <time>{date(item.createdAt)}</time>
        </article>
      ))}
      {!state?.activity.length && (
        <p className="empty-inline">No activity yet. Upload a file to begin.</p>
      )}
    </div>
  );
  const typeChart = () => (
    <div className="types">
      {a?.byType.length ? (
        a.byType.map((t) => (
          <div key={t.type}>
            <div className="flex-between">
              <span>
                {t.type} <small>({t.count})</small>
              </span>
              <strong>{size(t.bytes)}</strong>
            </div>
            <div className="track">
              <i
                style={{ width: `${a.bytes ? (t.bytes / a.bytes) * 100 : 0}%` }}
              />
            </div>
          </div>
        ))
      ) : (
        <p className="empty-inline">No active files to measure.</p>
      )}
    </div>
  );
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside
        ref={sidebar}
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile ? true : undefined}
        aria-label={mobile ? "Workspace navigation" : undefined}
        className={mobile ? "sidebar mobile-open" : "sidebar"}
      >
        <div className="brand">
          <Vault />
          <span>
            CloudVault<small>Personal workspace</small>
          </span>
          <button
            className="icon mobile-close"
            onClick={() => setMobile(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
        </div>
        <div className="workspace-label">Workspace</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.name}
              onClick={() => go(n.name)}
              aria-current={page === n.name ? "page" : undefined}
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {n.name === "My Files" && <small>{a?.count ?? 0}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span />
            {cloud ? "AWS workspace" : "Local environment"}
          </div>
          <p>
            {cloud ? (
              "Private S3 storage and DynamoDB metadata."
            ) : (
              <>
                Your files stay in this browser.
                <br />
                AWS integration is not connected.
              </>
            )}
          </p>
          <div className="profile">
            <span>CV</span>
            {cloud ? "Authenticated owner" : "Single-user demo"}
          </div>
        </div>
      </aside>
      <div className="workspace" inert={mobile || undefined}>
        <header className="topbar">
          <button
            className="icon mobile-menu"
            onClick={() => setMobile(true)}
            aria-label="Open navigation"
          >
            <Menu size={21} />
          </button>
          <span>
            Workspace <ChevronRight size={13} /> <strong>{page}</strong>
          </span>
          <span className="top-note">
            <span className="status-dot" />
            {cloud ? "AWS storage" : "Browser storage"}
          </span>
        </header>
        <main id="main" className="sheet">
          <div className="demo-notice">
            <span className="demo-tag">
              {cloud ? "AWS workspace" : "Demo mode"}
            </span>
            <span>
              {cloud
                ? "Files are stored in the configured AWS workspace."
                : "Local sample data. Changes are saved in this browser; no AWS resources are connected."}
            </span>
            <button onClick={() => go("Settings")}>
              Details <ArrowUpRight size={13} />
            </button>
          </div>
          {cloud && (
            <div className="section-heading">
              <button onClick={() => void refresh()} disabled={loading}>
                <RotateCcw size={14} />
                Refresh workspace
              </button>
              <button onClick={onSignOut}>Sign out</button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <h1>{page === "Dashboard" ? "Workspace overview" : page}</h1>
              <p>
                {page === "Dashboard"
                  ? "Your files, activity, and recovery — in one place."
                  : page === "My Files"
                    ? "A little more organized. A lot easier to find."
                    : page === "Shared Links"
                      ? cloud
                        ? "Manage temporary S3 download links."
                        : "Manage temporary download links created in this browser."
                      : page === "Recent Activity"
                        ? "A timeline of changes across your workspace."
                        : page === "Storage Analytics"
                          ? cloud
                            ? "Storage and activity recorded by CloudVault."
                            : "An honest view of your local demo storage."
                          : "Your workspace and integration configuration."}
              </p>
            </div>
            {(page === "Dashboard" || page === "My Files") && (
              <button
                className="primary"
                onClick={() => input.current?.click()}
                disabled={progress !== null}
              >
                <Plus size={17} />
                Upload files
              </button>
            )}
          </div>
          <input
            type="file"
            multiple
            ref={input}
            accept=".txt,.csv,.json,.pdf,.png,.jpg,.jpeg"
            className="sr-only"
            aria-label="Choose files to upload"
            onChange={(e) => void upload(e.target.files)}
          />
          {error && !modal && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => void refresh()}>Retry</button>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {progress !== null && (
            <div className="upload-progress" role="status">
              <span>
                {cloud
                  ? progress >= 95
                    ? "Verifying"
                    : "Uploading"
                  : "Saving"}{" "}
                {uploadName}
              </span>
              <progress value={progress} max="100" />
              <span>{progress}%</span>
            </div>
          )}
          {loading && !state ? (
            <div className="loading" role="status">
              <span>
                {cloud ? "Loading AWS workspace…" : "Loading local workspace…"}
              </span>
              {[1, 2, 3, 4].map((n) => (
                <div className="skeleton" key={n} />
              ))}
            </div>
          ) : (
            state && (
              <>
                {page === "Dashboard" && (
                  <>
                    <div className="metrics">
                      <Metric
                        label="Active storage"
                        value={size(a!.bytes)}
                        note={`${a!.count} files in your workspace`}
                      />
                      <Metric
                        label="Files stored"
                        value={String(a!.count)}
                        note={`${state.folders.length} logical folders`}
                      />
                      <Metric
                        label="Retained versions"
                        value={String(a!.retainedVersions)}
                        note={`${size(a!.retainedBytes)} of previous content`}
                      />
                      <Metric
                        label={cloud ? "Shared links" : "Demo links"}
                        value={String(
                          state.shares.filter(
                            (s) => Date.parse(s.expiresAt) > Date.now(),
                          ).length,
                        )}
                        note="Currently unexpired"
                      />
                    </div>
                    <div className="overview-grid">
                      <section
                        className="panel upload-panel"
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDrag(true);
                        }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDrag(false);
                          void upload(e.dataTransfer.files);
                        }}
                        data-drag={drag}
                      >
                        <div className="panel-heading">
                          <h2>A place for your next idea</h2>
                          <CloudUpload size={22} />
                        </div>
                        <p>Drop files here to keep your project moving.</p>
                        <button
                          onClick={() => input.current?.click()}
                          disabled={progress !== null}
                        >
                          Choose files <ArrowUpRight size={15} />
                        </button>
                        <small>
                          TXT, CSV, JSON, PDF, PNG, JPEG · up to 5 MB each
                        </small>
                      </section>
                      <section className="panel">
                        <div className="panel-heading">
                          <h2>Storage by type</h2>
                          <button
                            className="text-button"
                            onClick={() => go("Storage Analytics")}
                            aria-label="View storage analytics"
                          >
                            <ArrowUpRight size={18} />
                          </button>
                        </div>
                        {typeChart()}
                      </section>
                    </div>
                    <section className="recovery-strip">
                      <ShieldCheck size={23} />
                      <div>
                        <h2>Recovery starts with a retained version</h2>
                        <p>
                          {a!.retainedVersions} previous content versions ·{" "}
                          {a!.deleted} files in trash.{" "}
                          {cloud ? "" : "Local simulation. "}
                          Versioning is not an independent backup.
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          go("My Files");
                          setTrash(true);
                        }}
                      >
                        Review recovery <ChevronRight size={15} />
                      </button>
                    </section>
                    <section className="section">
                      <div className="section-heading">
                        <h2>
                          Recent files <small>{a!.count}</small>
                        </h2>
                        <button
                          onClick={() => {
                            go("My Files");
                            setTrash(false);
                          }}
                        >
                          View all files <ArrowUpRight size={14} />
                        </button>
                      </div>
                      {fileTable(
                        state.files
                          .filter((f) => f.status === "active")
                          .sort((a, b) =>
                            b.updatedAt.localeCompare(a.updatedAt),
                          )
                          .slice(0, 4),
                      )}
                    </section>
                    <section className="section">
                      <div className="section-heading">
                        <h2>Latest activity</h2>
                        <button onClick={() => go("Recent Activity")}>
                          View activity <ArrowUpRight size={14} />
                        </button>
                      </div>
                      {activity(3)}
                    </section>
                  </>
                )}
                {page === "My Files" && (
                  <>
                    <div className="files-tabs">
                      <button
                        className={!trash && !pending ? "selected" : ""}
                        onClick={() => {
                          setTrash(false);
                          setPending(false);
                        }}
                      >
                        All files <small>{a!.count}</small>
                      </button>
                      <button
                        className={trash ? "selected" : ""}
                        onClick={() => {
                          setTrash(true);
                          setPending(false);
                        }}
                      >
                        Trash <small>{a!.deleted}</small>
                      </button>
                      {cloud && (
                        <button
                          className={pending ? "selected" : ""}
                          onClick={() => {
                            setTrash(false);
                            setPending(true);
                          }}
                        >
                          Pending{" "}
                          <small>
                            {
                              state.files.filter(
                                (file) => file.status === "pending",
                              ).length
                            }
                          </small>
                        </button>
                      )}
                      <button
                        className="new-folder"
                        onClick={() => open("folder")}
                      >
                        <Folder size={15} />
                        New folder
                      </button>
                    </div>
                    <div className="file-controls">
                      <label className="search">
                        <Search size={17} />
                        <input
                          aria-label="Search files"
                          placeholder="Search files…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <select
                        aria-label="Filter folder"
                        value={folder}
                        onChange={(e) => setFolder(e.target.value)}
                      >
                        <option value="all">All folders</option>
                        {state.folders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Filter file type"
                        value={type}
                        onChange={(e) => setType(e.target.value)}
                      >
                        <option value="all">All types</option>
                        {[
                          "Documents",
                          "Images",
                          "PDF documents",
                          "Spreadsheets",
                        ].map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Sort files"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="updated">Recently modified</option>
                        <option value="name">Name A–Z</option>
                        <option value="size">Largest first</option>
                      </select>
                      <div className="view-toggle">
                        <button
                          aria-label="List view"
                          aria-pressed={!grid}
                          onClick={() => setGrid(false)}
                        >
                          <List size={17} />
                        </button>
                        <button
                          aria-label="Grid view"
                          aria-pressed={grid}
                          onClick={() => setGrid(true)}
                        >
                          <Grid2X2 size={16} />
                        </button>
                      </div>
                    </div>
                    <p className="result-count">
                      {files.length} {files.length === 1 ? "file" : "files"}
                      {trash ? " in trash" : ""}
                    </p>
                    <div
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!trash) void upload(e.dataTransfer.files);
                      }}
                    >
                      {fileTable(files)}
                    </div>
                    <p className="footnote">
                      Folders are metadata labels. Renaming or moving a file
                      does not change its stored content.
                    </p>
                  </>
                )}
                {page === "Shared Links" && (
                  <>
                    <div className="info-note">
                      <Link size={19} />
                      <p>
                        {cloud ? (
                          "Anyone with an unexpired link can download that file version. Moving the file to trash does not revoke the link."
                        ) : (
                          <>
                            These are browser-local simulations, not public S3
                            links. They expire automatically and work only in
                            this browser at this origin. This simulation blocks
                            links to trashed files; real version-pinned S3 URLs
                            may remain usable after soft deletion. S3 presigned
                            links are bearer credentials.
                          </>
                        )}
                      </p>
                    </div>
                    {state.shares.length ? (
                      <div className="share-list">
                        {state.shares.map((s) => (
                          <article key={s.id}>
                            <div>
                              <strong>{s.fileName}</strong>
                              <small>Created {date(s.createdAt)}</small>
                              <span className="pill">
                                {Date.parse(s.expiresAt) > Date.now()
                                  ? `Expires ${date(s.expiresAt)}`
                                  : "Expired"}
                              </span>
                            </div>
                            <button
                              onClick={() =>
                                void run(
                                  async () => {
                                    await navigator.clipboard.writeText(s.url);
                                  },
                                  cloud ? "Link copied" : "Demo link copied",
                                  false,
                                  false,
                                )
                              }
                              disabled={
                                !!cloud &&
                                (!s.url ||
                                  Date.parse(s.expiresAt) <= Date.now())
                              }
                              aria-label={`Copy link for ${s.fileName}`}
                            >
                              <Copy size={16} />
                              Copy link
                            </button>
                            {(!cloud ||
                              (s.url &&
                                Date.parse(s.expiresAt) > Date.now())) && (
                              <a href={s.url} rel="noreferrer">
                                Open <ArrowUpRight size={14} />
                              </a>
                            )}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty">
                        <Link size={27} />
                        <h3>No links yet</h3>
                        <p>
                          {cloud
                            ? "Create a temporary link from a file’s action menu."
                            : "Create a temporary demo link from a file’s action menu."}
                        </p>
                        <button onClick={() => go("My Files")}>
                          Browse files
                        </button>
                      </div>
                    )}
                  </>
                )}
                {page === "Recent Activity" && (
                  <>
                    <div className="section-heading">
                      <h2>{state.activity.length} recorded events</h2>
                      <button onClick={() => void refresh()} disabled={loading}>
                        <RotateCcw size={14} />
                        Refresh
                      </button>
                    </div>
                    {activity()}
                    <p className="footnote">
                      {cloud
                        ? "Showing up to 100 recent workspace events."
                        : "The local demo retains the latest 500 events. This is not a security audit log."}
                    </p>
                  </>
                )}
                {page === "Storage Analytics" && (
                  <>
                    <div className="metrics">
                      <Metric
                        label="Active file content"
                        value={size(a!.bytes)}
                        note={`${a!.count} active files`}
                      />
                      <Metric
                        label="Previous content"
                        value={size(a!.retainedBytes)}
                        note={`${a!.retainedVersions} retained versions`}
                      />
                      <Metric
                        label="Recoverable files"
                        value={String(a!.deleted)}
                        note="Currently in trash"
                      />
                      <Metric
                        label="Maximum upload"
                        value="5 MB"
                        note={
                          cloud
                            ? "Per file, verified on upload"
                            : "Per file, enforced locally"
                        }
                      />
                    </div>
                    <div className="overview-grid">
                      <section className="panel">
                        <div className="panel-heading">
                          <h2>Storage by type</h2>
                          <span className="pill">Active files</span>
                        </div>
                        {typeChart()}
                      </section>
                      <section className="panel">
                        <h2>Version footprint</h2>
                        <div className="footprint">
                          <div>
                            <span>Active content</span>
                            <strong>{size(a!.bytes)}</strong>
                          </div>
                          <div className="track">
                            <i
                              style={{
                                width: `${a!.bytes + a!.retainedBytes ? (a!.bytes / (a!.bytes + a!.retainedBytes)) * 100 : 0}%`,
                              }}
                            />
                          </div>
                          <div>
                            <span>Retained previous content</span>
                            <strong>{size(a!.retainedBytes)}</strong>
                          </div>
                          <div className="track neutral">
                            <i
                              style={{
                                width: `${a!.bytes + a!.retainedBytes ? (a!.retainedBytes / (a!.bytes + a!.retainedBytes)) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </div>
                        <p className="footnote">
                          {cloud
                            ? "Based on CloudVault metadata. Staging objects, manual S3 changes and billing overhead are excluded."
                            : "Computed from stored blobs. Excludes browser database overhead; this is not AWS billing usage."}
                        </p>
                      </section>
                    </div>
                    <section className="section">
                      <h2>Activity over the last 7 days</h2>
                      <ActivityChart state={state} />
                    </section>
                    <div className="info-note">
                      <ShieldCheck size={20} />
                      <p>
                        Version history can help recover changes and deletions.
                        It shares the storage account’s failure boundary and is
                        not an independent backup.
                      </p>
                    </div>
                  </>
                )}
                {page === "Settings" && cloud && (
                  <div className="setting-row">
                    <div>
                      <h2>AWS workspace</h2>
                      <p>Single-owner cloud storage.</p>
                    </div>
                    <div className="setting-panel">
                      <p>
                        Signed in through Cognito. File content is stored in
                        private S3 and workspace metadata in DynamoDB.
                      </p>
                      <button onClick={onSignOut}>Sign out</button>
                    </div>
                  </div>
                )}
                {page === "Settings" && !cloud && (
                  <>
                    <div className="setting-row">
                      <div>
                        <h2>Workspace</h2>
                        <p>A single-user local demonstration.</p>
                      </div>
                      <div className="setting-panel">
                        <label>
                          Workspace name
                          <input value="University project" readOnly />
                        </label>
                        <label>
                          Data mode
                          <input value="Local demo · IndexedDB" readOnly />
                        </label>
                        <p>
                          Uploads, folders, activity, and versions persist on
                          this browser and origin. Clearing browser storage
                          removes them.
                        </p>
                      </div>
                    </div>
                    <div className="setting-row">
                      <div>
                        <h2>Cloud integration</h2>
                        <p>Reserved for Phase 2.</p>
                      </div>
                      <div className="setting-panel">
                        <div className="flex-between">
                          <strong>AWS connection</strong>
                          <span className="pill">Not configured</span>
                        </div>
                        <p>
                          No credentials are requested or stored. Live API mode
                          is intentionally unavailable. Every future protected
                          route must require verified authentication.
                        </p>
                        <dl>
                          <dt>API Gateway</dt>
                          <dd>Not connected</dd>
                          <dt>S3 / DynamoDB</dt>
                          <dd>Not connected</dd>
                          <dt>SNS / EventBridge</dt>
                          <dd>Not connected</dd>
                        </dl>
                      </div>
                    </div>
                    <div className="setting-row">
                      <div>
                        <h2>Demo data</h2>
                        <p>Reset the workspace to practice a clean workflow.</p>
                      </div>
                      <div className="setting-panel">
                        <p>
                          Reset replaces local uploads and activity with clearly
                          labeled sample documents. Clear creates an empty
                          workspace. Both permanently remove this browser’s demo
                          files and links.
                        </p>
                        <div className="button-row">
                          <button onClick={() => open("reset")}>
                            <RotateCcw size={15} />
                            Reset samples
                          </button>
                          <button
                            className="danger"
                            onClick={() => open("clear")}
                          >
                            <Trash2 size={15} />
                            Clear workspace
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )
          )}
          <footer className="page-footer">
            <span>CloudVault · Cloud Technology PBL</span>
            <span>
              {cloud ? "AWS environment" : "Phase 1 / Local environment"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal.kind === "versions"
              ? "Version history"
              : modal.kind === "rename"
                ? "Rename file"
                : modal.kind === "move"
                  ? "Move file"
                  : modal.kind === "folder"
                    ? "Create folder"
                    : modal.kind === "share"
                      ? cloud
                        ? "Create temporary download link"
                        : "Create temporary demo link"
                      : modal.kind === "delete"
                        ? "Move file to trash?"
                        : modal.kind === "reset"
                          ? "Reset demo workspace?"
                          : "Clear local workspace?"
          }
          close={close}
        >
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {modal.file && (
            <p className="modal-file">
              <FileText size={17} />
              {modal.file.name}
            </p>
          )}
          {(modal.kind === "rename" || modal.kind === "folder") && (
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void run(
                  () =>
                    modal.kind === "folder"
                      ? api.folder(name)
                      : api.patch(modal.file!.id, { name }),
                  modal.kind === "folder" ? "Folder created" : "File renamed",
                );
              }}
            >
              <label>
                {modal.kind === "folder" ? "Folder name" : "File name"}
                <input
                  autoFocus
                  required
                  maxLength={modal.kind === "folder" ? 80 : 180}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="modal-footer">
                <button type="button" onClick={close}>
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  Save
                </button>
              </div>
            </form>
          )}
          {modal.kind === "move" && (
            <>
              <label>
                Destination folder
                <select
                  autoFocus
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Unfiled</option>
                  {state?.folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="modal-footer">
                <button onClick={close}>Cancel</button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        api.patch(modal.file!.id, {
                          folderId: destination || null,
                        }),
                      "File moved",
                    )
                  }
                >
                  Move file
                </button>
              </div>
            </>
          )}
          {modal.kind === "delete" && (
            <>
              <p>
                The file will be hidden from My Files. Its retained content
                versions remain available in Trash for recovery.
              </p>
              <div className="modal-footer">
                <button onClick={close}>Cancel</button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api.remove(modal.file!.id),
                      "File moved to trash",
                    )
                  }
                >
                  Move to trash
                </button>
              </div>
            </>
          )}
          {modal.kind === "versions" && (
            <>
              <p className="muted">
                Version IDs are opaque. Restoring content creates a new current
                version; delete markers have no content.
              </p>
              {cloud && versionLoading && (
                <p role="status">Loading versions…</p>
              )}
              {cloud && versionError && (
                <p role="alert" className="error">
                  {versionError}
                </p>
              )}
              {cloud && !versionLoading && versionPage?.items.length === 0 && (
                <p>No stored versions.</p>
              )}
              <div className="version-list">
                {(cloud
                  ? versionPage?.items
                  : state?.versions[modal.file!.id]
                )?.map((v) => (
                  <article key={v.versionId}>
                    <div>
                      <strong>
                        {v.isDeleteMarker
                          ? "Delete marker"
                          : v.isLatest
                            ? "Current version"
                            : "Retained content"}
                      </strong>
                      <small>
                        {date(v.createdAt)} · {size(v.size)}
                      </small>
                      <code title={v.versionId}>
                        {v.versionId.slice(0, 12)}…
                      </code>
                    </div>
                    {!v.isDeleteMarker && modal.file?.status === "active" && (
                      <button
                        type="button"
                        aria-label={`Download version ${v.versionId}`}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            async () =>
                              save(
                                await api.download(modal.file!.id, v.versionId),
                              ),
                            "Download started",
                            false,
                            false,
                          )
                        }
                      >
                        <ArrowDownToLine size={15} /> Download
                      </button>
                    )}
                    {!v.isDeleteMarker && (
                      <button
                        disabled={
                          (v.isLatest &&
                            (!cloud ||
                              (modal.file?.status === "active" &&
                                modal.file?.currentVersionId ===
                                  v.versionId))) ||
                          busy
                        }
                        onClick={() => setRestore(v.versionId)}
                      >
                        {v.isLatest &&
                        modal.file?.status === "active" &&
                        (!cloud || modal.file?.currentVersionId === v.versionId)
                          ? "Current"
                          : "Restore"}
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {cloud && versionPage?.nextCursor && (
                <button
                  disabled={versionLoading}
                  onClick={() => {
                    const cursor = versionPage.nextCursor;
                    setVersionLoading(true);
                    setVersionError("");
                    void cloud
                      .versions(modal.file!.id, cursor)
                      .then((result) => {
                        setVersionPage((previous) =>
                          previous?.nextCursor === cursor
                            ? {
                                items: [...previous.items, ...result.items],
                                nextCursor: result.nextCursor,
                              }
                            : previous,
                        );
                      })
                      .catch((error: Error) => setVersionError(error.message))
                      .finally(() => setVersionLoading(false));
                  }}
                >
                  Load more versions
                </button>
              )}
              {restore && (
                <div className="restore-confirm">
                  <strong>Restore this retained content?</strong>
                  <p>
                    A new current version will be created. The file will become
                    active again.
                  </p>
                  <div className="button-row">
                    <button onClick={() => setRestore("")}>Cancel</button>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.restore(modal.file!.id, restore),
                          "Version restored",
                        )
                      }
                    >
                      Confirm restore
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {modal.kind === "share" && (
            <>
              <p>
                {cloud
                  ? "Anyone with this link can download the selected version until it expires."
                  : "This link is a local simulation, usable only in this browser at this origin. Anyone using this browser can access it until expiry while the file is active."}
              </p>
              <label>
                Link expires in
                <select
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                >
                  <option value={5}>5 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={1}>1 minute</option>
                </select>
              </label>
              {shareUrl && (
                <label>
                  {cloud ? "Download link" : "Demo link"}
                  <input readOnly value={shareUrl} />
                  <button
                    onClick={() =>
                      void run(
                        () => navigator.clipboard.writeText(shareUrl),
                        "Link copied",
                        false,
                        false,
                      )
                    }
                  >
                    <Copy size={15} />
                    Copy link
                  </button>
                </label>
              )}
              <div className="modal-footer">
                <button onClick={close}>Done</button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        const s = await api.share(
                          modal.file!.id,
                          minutes,
                          location.origin,
                        );
                        setShareUrl(s.url);
                      },
                      cloud
                        ? "Temporary download link created"
                        : "Temporary demo link created",
                      false,
                    )
                  }
                >
                  Create link
                </button>
              </div>
            </>
          )}
          {(modal.kind === "reset" || modal.kind === "clear") && (
            <>
              <p>
                This permanently removes this browser’s uploaded files, retained
                versions, activity, and sharing links.
                {modal.kind === "reset"
                  ? " Sample documents will be added again."
                  : " Your workspace will be empty."}
              </p>
              <div className="modal-footer">
                <button onClick={close}>Cancel</button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => demoApi.reset(modal.kind === "clear"),
                      "Workspace updated",
                    )
                  }
                >
                  {modal.kind === "clear" ? "Clear workspace" : "Reset samples"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
