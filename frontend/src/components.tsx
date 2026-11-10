import { useEffect, useRef, useId } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { WorkspaceSnapshot } from "./models";
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button className="icon" aria-label="Close dialog" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
export function Vault() {
  return (
    <svg
      className="vault-mark"
      width="28"
      height="31"
      viewBox="0 0 28 31"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14 2 26 8v14l-12 7L2 22V8L14 2Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="m2 8 12 7 12-7M14 15v14M8 11V7l6-3 6 3v4"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}
export function ActivityChart({ state }: { state: WorkspaceSnapshot }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 6 + i);
    return d;
  });
  const vals = days.map(
    (d) =>
      state.activity.filter(
        (a) => new Date(a.createdAt).toDateString() === d.toDateString(),
      ).length,
  );
  const max = Math.max(...vals, 1);
  return (
    <div
      className="bar-chart"
      role="img"
      aria-label={`Recorded events over seven days: ${days.map((d, i) => `${d.toLocaleDateString(undefined, { weekday: "short" })}: ${vals[i]}`).join(", ")}`}
    >
      <div className="bars">
        {days.map((d, i) => (
          <div key={i}>
            <span>{vals[i]}</span>
            <i style={{ height: `${(vals[i] / max) * 125}px` }} />
            <small>
              {d.toLocaleDateString(undefined, { weekday: "short" })}
            </small>
          </div>
        ))}
      </div>
      <p className="footnote">
        Recorded events per day · local time · {vals.reduce((a, b) => a + b, 0)}{" "}
        total
      </p>
    </div>
  );
}
