// In-app replacement for window.prompt / confirm / alert, styled like the rest of Melodical.
import { useEffect, useRef, useState } from "react";

type Choice = { id: string; label: string; hint?: string };
type Request = {
  title: string;
  body?: string;
  input?: { value: string; placeholder?: string };
  choices?: Choice[];
  confirm: string;
  cancel?: string | null; // null = no cancel button (alerts)
  danger?: boolean;
};
export type DialogResult = { value: string; choice?: string } | null;

let enqueue: ((r: Request & { resolve: (v: DialogResult) => void }) => void) | null = null;

function open(r: Request) {
  return new Promise<DialogResult>((resolve) => {
    if (enqueue) enqueue({ ...r, resolve });
    else resolve(null);
  });
}

/** Text input dialog. Resolves with the trimmed text, or null if cancelled/empty. */
export async function askText(title: string, value: string, opts: { body?: string; confirm?: string; placeholder?: string } = {}) {
  const r = await open({ title, body: opts.body, input: { value, placeholder: opts.placeholder }, confirm: opts.confirm ?? "Save" });
  const v = r?.value.trim();
  return v ? v : null;
}

/** Text + one-of-several choice (e.g. name + starting template). */
export async function askTextAndChoice(title: string, value: string, choices: Choice[], confirm = "Create", placeholder = "Song name") {
  const r = await open({ title, input: { value, placeholder }, choices, confirm });
  const v = r?.value.trim();
  return v ? { name: v, choice: r!.choice ?? choices[0].id } : null;
}

export async function askConfirm(title: string, body: string, confirm = "Delete", danger = true) {
  return !!(await open({ title, body, confirm, danger }));
}

export async function notify(title: string, body?: string) {
  await open({ title, body, confirm: "OK", cancel: null });
}

export function DialogHost() {
  const [queue, setQueue] = useState<(Request & { resolve: (v: DialogResult) => void })[]>([]);
  const cur = queue[0];
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);

  useEffect(() => {
    if (!cur) return;
    setValue(cur.input?.value ?? "");
    setChoice(cur.choices?.[0]?.id);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      } else okRef.current?.focus();
    });
  }, [cur]);

  if (!cur) return null;

  const close = (ok: boolean) => {
    cur.resolve(ok ? { value, choice } : null);
    setQueue((q) => q.slice(1));
  };
  const canOk = !cur.input || value.trim().length > 0;

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && cur.cancel !== null && close(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && cur.cancel !== null) close(false);
        if (e.key === "Enter" && canOk && (e.target as HTMLElement).tagName !== "BUTTON") close(true);
      }}
    >
      <div className={`dlg pop ${cur.danger ? "is-danger" : ""}`} role="dialog" aria-modal="true" aria-label={cur.title}>
        <h3>{cur.title}</h3>
        {cur.body && <p>{cur.body}</p>}
        {cur.input && (
          <input
            ref={inputRef}
            className="field"
            value={value}
            placeholder={cur.input.placeholder}
            onChange={(e) => setValue(e.target.value)}
            maxLength={60}
          />
        )}
        {cur.choices && (
          <>
            <div className="label">Start from</div>
            <div className="dlg-choices">
              {cur.choices.map((c) => (
                <button key={c.id} className={choice === c.id ? "on" : ""} onClick={() => setChoice(c.id)}>
                  <b>{c.label}</b>
                  {c.hint && <span>{c.hint}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="dlg-actions">
          {cur.cancel !== null && (
            <button className="ghost" onClick={() => close(false)}>
              {cur.cancel ?? "Cancel"}
            </button>
          )}
          <button ref={okRef} className={cur.danger ? "danger-btn" : "primary"} disabled={!canOk} onClick={() => close(true)}>
            {cur.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
