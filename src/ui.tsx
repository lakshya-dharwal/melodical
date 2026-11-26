import { useEffect, useState } from "react";

export function Stepper(props: {
  label: string;
  value: number;
  unit: string;
  step: number;
  signed?: boolean;
  onChange: (v: number) => void;
}) {
  const shown = props.signed && props.value > 0 ? `+${props.value}` : String(props.value);
  return (
    <div className="stepper">
      <span className="lbl">{props.label}</span>
      <div>
        <button onClick={() => props.onChange(props.value - props.step)}>−</button>
        <b>
          {shown}
          <small>{props.unit}</small>
        </b>
        <button onClick={() => props.onChange(props.value + props.step)}>+</button>
      </div>
    </div>
  );
}

export function Fader(props: {
  label: string;
  value: number;
  max?: number;
  enabled?: boolean;
  onToggle?: () => void;
  onChange: (v: number) => void;
}) {
  const on = props.enabled ?? true;
  const max = props.max ?? 1;
  return (
    <div className={`fader ${on ? "" : "off"}`}>
      <div className="fader-top">
        {props.onToggle ? (
          <button className={`sw ${on ? "on" : ""}`} onClick={props.onToggle} aria-label={`Toggle ${props.label}`} />
        ) : (
          <span className="sw-pad" />
        )}
        <span>{props.label}</span>
        <em>{Math.round(props.value * 100)}</em>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={0.01}
        value={props.value}
        disabled={!on}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ ["--v" as string]: `${(props.value / max) * 100}%` }}
      />
    </div>
  );
}

export const Label = ({ children }: { children: React.ReactNode }) => <div className="label">{children}</div>;

export function Chips<T extends string>(props: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {props.options.map((o) => (
        <button key={o.id} className={props.value === o.id ? "on" : ""} onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChordInput({ value, shown, onCommit }: { value: string; shown: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing)
    return (
      <button className="sym" onClick={() => setEditing(true)} title={shown !== value ? `written as ${value}` : "Click to change"}>
        {shown}
      </button>
    );
  const done = () => {
    setEditing(false);
    const t = v.trim();
    if (t && t !== value) onCommit(t);
    else setV(value);
  };
  return (
    <input
      className="sym-in"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") done();
        if (e.key === "Escape") {
          setV(value);
          setEditing(false);
        }
      }}
    />
  );
}

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="28" height="28">
    <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
  </svg>
);
export const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26">
    <rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" />
  </svg>
);
export const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
  </svg>
);
export const StartIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18">
    <rect x="5" y="5" width="2.6" height="14" rx="1" fill="currentColor" />
    <path d="M19 5v14L9 12z" fill="currentColor" />
  </svg>
);
