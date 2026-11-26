// Projects live in localStorage (small JSON); vocal takes live in IndexedDB (big Float32 audio).
import type { Options } from "./engine";
import { DEFAULT_MIX, type MixSettings } from "./mix";

export type Project = {
  id: string;
  name: string;
  text: string; // chord map
  transpose: number;
  opts: Options;
  mix: MixSettings;
  selectedTake: string | null;
  updatedAt: number;
};

export type Take = {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  offset: number; // song seconds where the first sample sits
  bpm: number; // tempo it was sung against
  data: Float32Array;
};

const KEY = "melodical.projects.v1";

export function loadProjects(): { projects: Project[]; currentId: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      v.projects = v.projects.map((p: Project) => ({ ...p, mix: { ...DEFAULT_MIX, ...p.mix } }));
      return v;
    }
  } catch {
    /* fall through to fresh state */
  }
  return { projects: [], currentId: null };
}

export function saveProjects(projects: Project[], currentId: string | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ projects, currentId }));
  } catch (e) {
    console.warn("couldn't save projects", e);
  }
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

export const putTake = (t: Take) => tx("readwrite", (s) => s.put(t));
export const deleteTake = (id: string) => tx("readwrite", (s) => s.delete(id));
export const getTakes = (projectId: string) =>
  tx<Take[]>("readonly", (s) => s.index("project").getAll(projectId)).then((ts) => ts.sort((a, b) => a.createdAt - b.createdAt));
