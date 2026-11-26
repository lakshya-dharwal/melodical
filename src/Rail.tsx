import { Logo } from "./Logo";

export type Page = "home" | "create" | "compose" | "record" | "mix" | "settings" | "lyrics" | "hum" | "community";

const I = {
  home: <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-5.5h-5V21H5a1 1 0 0 1-1-1z" />,
  create: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  compose: (
    <>
      <rect x="3.5" y="5" width="7.5" height="6" rx="2" />
      <rect x="13" y="5" width="7.5" height="6" rx="2" />
      <rect x="3.5" y="13.5" width="17" height="5.5" rx="2" />
    </>
  ),
  record: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
    </>
  ),
  mix: <path d="M6 4v5m0 4v7M12 4v9m0 4v3M18 4v3m0 4v9M4 11h4M10 15h4M16 9h4" />,
  lyrics: <path d="M5 6h14M5 10.5h14M5 15h9M5 19.5h6" />,
  hum: <path d="M3 12h2l2-5 3 10 3-14 3 12 2-6 2 3h1" />,
  community: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <circle cx="17" cy="9.5" r="2.3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M14.5 18a4 4 0 0 1 6.5-3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
    </>
  ),
};

const MAIN: { id: Page; label: string; icon: keyof typeof I }[] = [
  { id: "home", label: "Your songs", icon: "home" },
  { id: "create", label: "New song", icon: "create" },
];
const STUDIO: { id: Page; label: string; icon: keyof typeof I }[] = [
  { id: "compose", label: "Chords & sound", icon: "compose" },
  { id: "record", label: "Record vocals", icon: "record" },
  { id: "mix", label: "Mix & export", icon: "mix" },
];
const SOON: { id: Page; label: string; icon: keyof typeof I }[] = [
  { id: "lyrics", label: "Lyrics · soon", icon: "lyrics" },
  { id: "hum", label: "Hum to chords · soon", icon: "hum" },
  { id: "community", label: "Collab · soon", icon: "community" },
];

export const SOON_COPY: Record<string, { title: string; body: string }> = {
  lyrics: { title: "Lyrics", body: "Write your words right under each chord, see them scroll while you record, and export a lyric sheet with chords." },
  hum: { title: "Hum to chords", body: "Hum or sing a melody idea and Melodical suggests chords that fit it, so you can go from a tune in your head to a full backing track." },
  community: { title: "Collab", body: "Share a song with a friend, let them add a take on top, and pick the best version together." },
};

function Icon({ name }: { name: keyof typeof I }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {I[name]}
    </svg>
  );
}

export function Rail({ page, onGo, recording }: { page: Page; onGo: (p: Page) => void; recording: boolean }) {
  const item = (it: { id: Page; label: string; icon: keyof typeof I }, soon = false) => (
    <button
      key={it.id}
      className={`rail-btn ${page === it.id ? "on" : ""} ${soon ? "soon" : ""} ${it.id === "record" && recording ? "rec" : ""}`}
      onClick={() => onGo(it.id)}
      aria-label={it.label}
    >
      <Icon name={it.icon} />
      <span className="tip">{it.label}</span>
    </button>
  );
  return (
    <nav className="rail">
      <button className="rail-logo" onClick={() => onGo("home")} aria-label="Melodical home">
        <Logo size={46} />
      </button>
      {MAIN.map((m) => item(m))}
      <i className="rail-sep" />
      {STUDIO.map((m) => item(m))}
      <i className="rail-sep" />
      {SOON.map((m) => item(m, true))}
      <div className="rail-fill" />
      {item({ id: "settings", label: "Settings & sync", icon: "settings" })}
    </nav>
  );
}
