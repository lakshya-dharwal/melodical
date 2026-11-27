// Projects live in localStorage (small JSON); vocal takes live in IndexedDB (big Float32 audio).
import type { Options } from "./engine";
import { DEFAULT_MIX, DEFAULT_VOICE, voiceFromPreset, type MixSettings, type Voice } from "./mix";

export type Project = {
  id: string;
  name: string;
  text: string; // chord map
  transpose: number;
  opts: Options;
  mix: MixSettings;
  legacyMix?: { mode?: string; vocalReverb?: number; tune?: number }; // pre-per-take vocal settings
  selectedTake: string | null;
  updatedAt: number;
  seed?: boolean; // the untouched starter a fresh browser opens with (dropped on first cloud sign-in)
};

export type Take = {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  offset: number; // song seconds where the first sample sits, with `latencyUsed` already removed
  latencyUsed?: number; // round-trip seconds subtracted when the take was saved
  nudgeMs?: number; // manual fine-tune, + = earlier
  voice?: Voice;
  bpm: number; // tempo it was sung against
  data: Float32Array;
};

/** Takes saved before sync existed assumed ~25 ms of round trip. */
const LEGACY_LATENCY = 0.025;

/** Where the take sits on the song timeline, using the current sync calibration. */
export function takeOffset(t: Take, latency: number | null) {
  const used = t.latencyUsed ?? LEGACY_LATENCY;
  const shift = latency === null ? 0 : used - latency; // re-apply with the measured value
  return t.offset + shift - (t.nudgeMs ?? 0) / 1000;
}

export function takeVoice(t: Take, legacyMix?: { mode?: string; vocalReverb?: number; tune?: number }): Voice {
  if (t.voice) return t.voice;
  if (!legacyMix) return DEFAULT_VOICE;
  const base = voiceFromPreset(legacyMix.mode === "pure" ? "pure" : "natural", legacyMix.mode === "tuned" ? legacyMix.tune ?? 0.8 : 0);
  return { ...base, reverb: legacyMix.mode === "pure" ? 0 : legacyMix.vocalReverb ?? base.reverb };
}

// ---------- device sync calibration (per browser, not per song) ----------
const SYNC_KEY = "melodical.sync.v1";
export function loadSync(): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(SYNC_KEY) ?? "null");
    return typeof v?.latency === "number" ? v.latency : null;
  } catch {
    return null;
  }
}
export function saveSync(latency: number | null) {
  try {
    if (latency === null) localStorage.removeItem(SYNC_KEY);
    else localStorage.setItem(SYNC_KEY, JSON.stringify({ latency, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

const KEY = "melodical.projects.v1";

export function loadProjects(): { projects: Project[]; currentId: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      v.projects = v.projects.map((p: Project) => ({ ...p, legacyMix: p.legacyMix ?? p.mix, mix: { ...DEFAULT_MIX, ...p.mix } }));
      return v;
    }
  } catch {
    /* fall through to fresh state */
  }
  return { projects: [], currentId: null };
}

// ---------- change hook (cloud sync listens here; nothing is registered without cloud config) ----------
export type StoreEvent = { type: "projects"; projects: Project[] } | { type: "putTake"; take: Take } | { type: "deleteTake"; id: string };
let hook: ((e: StoreEvent) => void) | null = null;
export function onStoreChange(h: ((e: StoreEvent) => void) | null) {
  hook = h;
}
const fire = (e: StoreEvent) => {
  try {
    hook?.(e);
  } catch (err) {
    console.warn("store hook failed", err);
  }
};

/** Write projects without notifying the hook (used when applying changes pulled from the cloud). */
export function writeProjectsRaw(projects: Project[], currentId: string | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ projects, currentId }));
  } catch (e) {
    console.warn("couldn't save projects", e);
  }
}

export function saveProjects(projects: Project[], currentId: string | null) {
  writeProjectsRaw(projects, currentId);
  fire({ type: "projects", projects });
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("melodical", 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore("takes", { keyPath: "id" });
      s.createIndex("project", "projectId");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((res, rej) => {
        const req = fn(d.transaction("takes", mode).objectStore("takes"));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }),
  );
}

/** Raw writes skip the change hook (cloud pulls use these so they don't echo back up). */
export const putTakeRaw = (t: Take) => tx("readwrite", (s) => s.put(t));
export const deleteTakeRaw = (id: string) => tx("readwrite", (s) => s.delete(id));
export const putTake = (t: Take) => putTakeRaw(t).then((r) => (fire({ type: "putTake", take: t }), r));
export const deleteTake = (id: string) => deleteTakeRaw(id).then((r) => (fire({ type: "deleteTake", id }), r));
export const getTake = (id: string) => tx<Take | undefined>("readonly", (s) => s.get(id));
export const getTakeIds = () => tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((ks) => ks.map(String));
export const getTakeIdsFor = (projectId: string) =>
  tx<IDBValidKey[]>("readonly", (s) => s.index("project").getAllKeys(projectId)).then((ks) => ks.map(String));
export const getTakes = (projectId: string) =>
  tx<Take[]>("readonly", (s) => s.index("project").getAll(projectId)).then((ts) => ts.sort((a, b) => a.createdAt - b.createdAt));
