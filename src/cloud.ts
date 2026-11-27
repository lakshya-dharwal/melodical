// Optional cloud backup + sync (Supabase). Off unless VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set;
// without them nothing here loads or runs and the app stays browser-only.
//
// Model: projects and take metadata are rows; take audio is FLAC in a private bucket. Newer `updatedAt` wins,
// deletes are tombstones. Local edits mark things dirty and push (debounced, queued while offline);
// pulls happen on sign-in, on focus and when the connection comes back.
import { useSyncExternalStore } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeFlac, encodeFlac } from "./flac";
import { DEFAULT_MIX } from "./mix";
import {
  deleteTakeRaw,
  getTake,
  getTakeIds,
  getTakeIdsFor,
  loadProjects,
  onStoreChange,
  putTakeRaw,
  writeProjectsRaw,
  type Project,
  type StoreEvent,
  type Take,
} from "./store";

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const URL_ = env.VITE_SUPABASE_URL?.trim();
const KEY = env.VITE_SUPABASE_ANON_KEY?.trim();

export type CloudStatus = "off" | "idle" | "syncing" | "offline" | "error";
export type CloudState = {
  enabled: boolean;
  ready: boolean; // session restored (or no session) — avoids flashing the sign-in form
  user: { id: string; email: string | null } | null;
  status: CloudStatus;
  lastSync: number | null;
  error?: string;
};
export type PullResult = { projects: Project[]; takesChanged: Set<string> };

const enabled = !!(URL_ && KEY);
let state: CloudState = { enabled, ready: !enabled, user: null, status: enabled ? "idle" : "off", lastSync: null };
const subs = new Set<() => void>();
const set = (patch: Partial<CloudState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

// ---------- persisted bookkeeping ----------
type Pending = {
  projTombs: Record<string, number>; // project id -> deleted at
  takes: Record<string, number>; // take id -> meta changed at
  takeTombs: Record<string, number>; // take id -> deleted at
};
type UserBook = {
  seeded: boolean; // first full upload done for this user on this browser
  projAt: Record<string, number>; // project id -> updatedAt last synced
  takeAt: Record<string, number>; // take id -> updated_at last synced
  uploaded: Record<string, 1>; // take ids whose FLAC is already in the bucket
  lastSync: number | null;
};
const PENDING_KEY = "melodical.cloud.pending.v1";
const bookKey = (uid: string) => `melodical.cloud.user.v1.${uid}`;
const readJson = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full: sync just retries later */
  }
};
let pending: Pending = readJson<Pending>(PENDING_KEY, { projTombs: {}, takes: {}, takeTombs: {} });
const savePending = () => writeJson(PENDING_KEY, pending);
let book: UserBook | null = null;
const freshBook = (): UserBook => ({ seeded: false, projAt: {}, takeAt: {}, uploaded: {}, lastSync: null });
const saveBook = () => state.user && book && writeJson(bookKey(state.user.id), book);

// ---------- local change hook ----------
let lastIds = new Set<string>();
function onLocal(e: StoreEvent) {
  const now = Date.now();
  if (e.type === "projects") {
    const ids = new Set(e.projects.map((p) => p.id));
    lastIds.forEach((id) => !ids.has(id) && (pending.projTombs[id] = now));
    lastIds = ids;
  } else if (e.type === "putTake") {
    pending.takes[e.take.id] = now;
    delete pending.takeTombs[e.take.id];
  } else {
    pending.takeTombs[e.id] = now;
    delete pending.takes[e.id];
  }
  savePending();
  schedule("push", 1500);
}

// ---------- client + auth ----------
let client: SupabaseClient | null = null;
let onPullCb: ((r: PullResult) => void) | null = null;
let started = false;

async function start() {
  if (!enabled || started) return;
  started = true;
  lastIds = new Set(loadProjects().projects.map((p) => p.id));
  onStoreChange(onLocal);
  try {
    const { createClient } = await import("@supabase/supabase-js");
    client = createClient(URL_!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });
  } catch (e) {
    set({ ready: true, status: "error", error: "Couldn’t load cloud backup." });
    console.warn(e);
    return;
  }
  client.auth.onAuthStateChange((_ev, session) => {
    // Never await Supabase calls inside this callback; hop off it first.
    setTimeout(() => {
      const u = session?.user ?? null;
      if (u && u.id !== state.user?.id) {
        book = readJson(bookKey(u.id), freshBook());
        set({ ready: true, user: { id: u.id, email: u.email ?? null }, lastSync: book.lastSync, status: navigator.onLine ? "idle" : "offline", error: undefined });
        cleanAuthUrl();
        schedule("full", 0);
      } else if (!u && state.user) {
        book = null;
        set({ ready: true, user: null, status: "idle", lastSync: null, error: undefined });
      } else {
        set({ ready: true });
      }
    }, 0);
  });
  window.addEventListener("online", () => {
    if (state.user) set({ status: "idle" });
    schedule("full", 500);
  });
  window.addEventListener("offline", () => state.user && set({ status: "offline" }));
  const onFocus = () => {
    if (document.visibilityState === "visible" && Date.now() - lastPull > 15_000) schedule("full", 300);
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
}

function cleanAuthUrl() {
  const u = new URL(window.location.href);
  if (u.searchParams.has("code") || u.hash.includes("access_token")) {
    u.searchParams.delete("code");
    history.replaceState(null, "", u.pathname + (u.search === "?" ? "" : u.search));
  }
}

const redirectTo = () => window.location.origin + window.location.pathname;

async function signInWithGoogle() {
  if (!client) return { error: "Cloud backup isn’t connected." };
  const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
  return { error: error?.message };
}
async function sendMagicLink(email: string) {
  if (!client) return { error: "Cloud backup isn’t connected." };
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } });
  return { error: error?.message };
}
async function signOut() {
  if (!client) return;
  if (state.user && navigator.onLine && !running) await runSync("push").catch(() => {}); // last flush
  await client.auth.signOut();
}

// ---------- scheduling ----------
let timer = 0;
let want: "push" | "full" | null = null;
let running = false;
let lastPull = 0;
let retry = 0;
function schedule(kind: "push" | "full", delay: number) {
  if (!client || !state.user) return;
  want = want === "full" || kind === "full" ? "full" : "push";
  clearTimeout(timer);
  timer = window.setTimeout(kick, delay);
}
async function kick() {
  timer = 0;
  if (running || !want) return; // a running sync re-kicks itself when done
  if (!navigator.onLine) return set({ status: "offline" }); // the `online` event re-kicks
  const kind = want;
  want = null;
  running = true;
  let delay = 300;
  try {
    await runSync(kind);
    retry = 0;
  } catch (e) {
    console.warn("cloud sync failed", e);
    retry = Math.min(retry + 1, 6);
    set({ status: navigator.onLine ? "error" : "offline", error: e instanceof Error ? e.message : String(e) });
    want = want === "full" ? "full" : kind;
    delay = 5000 * 2 ** retry;
  } finally {
    running = false;
    if (want) {
      clearTimeout(timer);
      timer = window.setTimeout(kick, delay);
    }
  }
}

// ---------- sync ----------
type ProjRow = { id: string; data: Project | null; updated_at: number; deleted: boolean };
type TakeRow = { id: string; project_id: string | null; meta: Omit<Take, "data"> | null; updated_at: number; deleted: boolean };

const isEmpty = (o: Record<string, unknown>) => Object.keys(o).length === 0;
const metaOf = (t: Take): Omit<Take, "data"> => {
  const { data: _data, ...meta } = t;
  return meta;
};
const objPath = (uid: string, id: string) => `${uid}/${id}.flac`;

async function runSync(kind: "push" | "full") {
  if (!client || !state.user || !book) return;
  const c = client;
  const uid = state.user.id;
  const b = book;
  set({ status: "syncing" });

  // ----- pull -----
  let pulled: PullResult | null = null;
  let remoteHasProjects = false;
  if (kind === "full") {
    lastPull = Date.now();
    const [pr, tr] = await Promise.all([
      c.from("projects").select("id,data,updated_at,deleted"),
      c.from("takes").select("id,project_id,meta,updated_at,deleted"),
    ]);
    if (pr.error) throw pr.error;
    if (tr.error) throw tr.error;
    const rProjects = (pr.data ?? []) as ProjRow[];
    const rTakes = (tr.data ?? []) as TakeRow[];
    remoteHasProjects = rProjects.some((r) => !r.deleted);

    const local = loadProjects();
    const byId = new Map(local.projects.map((p) => [p.id, p]));
    let changed = false;
    const takesChanged = new Set<string>();
    const removedProjects: string[] = [];

    for (const r of rProjects) {
      const l = byId.get(r.id);
      const at = Number(r.updated_at);
      if (r.deleted) {
        if (l && l.updatedAt <= at) {
          byId.delete(r.id);
          removedProjects.push(r.id);
          changed = true;
        }
        if (!l || l.updatedAt <= at) b.projAt[r.id] = at;
        continue;
      }
      const tomb = pending.projTombs[r.id];
      if (tomb && tomb >= at) continue; // our delete is newer; pushed below
      if (tomb) delete pending.projTombs[r.id]; // edited elsewhere after we deleted it: bring it back
      if (!r.data) continue;
      if (!l || at > l.updatedAt) {
        byId.set(r.id, { ...r.data, id: r.id, updatedAt: at, mix: { ...DEFAULT_MIX, ...r.data.mix } });
        b.projAt[r.id] = at;
        changed = true;
      } else if (l.updatedAt === at) b.projAt[r.id] = at;
    }

    // First sign-in on a fresh browser: don't upload the untouched starter on top of an existing library.
    if (!b.seeded && remoteHasProjects) {
      for (const p of [...byId.values()]) {
        if (p.seed && !b.projAt[p.id] && (await getTakeIdsFor(p.id)).length === 0) {
          byId.delete(p.id);
          changed = true;
        }
      }
    }

    for (const id of removedProjects) {
      for (const tid of await getTakeIdsFor(id)) {
        await deleteTakeRaw(tid);
        delete pending.takes[tid];
      }
      takesChanged.add(id);
    }

    const localTakeIds = new Set(await getTakeIds());
    for (const r of rTakes) {
      const at = Number(r.updated_at);
      const has = localTakeIds.has(r.id);
      if (r.deleted) {
        if (has && !((pending.takes[r.id] ?? 0) > at)) {
          const t = await getTake(r.id);
          await deleteTakeRaw(r.id);
          delete pending.takes[r.id];
          if (t) takesChanged.add(t.projectId);
        }
        delete b.uploaded[r.id];
        b.takeAt[r.id] = at;
        continue;
      }
      if (pending.takeTombs[r.id] || !r.meta) continue;
      if (!byId.has(r.meta.projectId)) continue; // its song is gone (or never arrived)
      if (!has) {
        const dl = await c.storage.from("takes").download(objPath(uid, r.id));
        if (dl.error || !dl.data) {
          console.warn("couldn’t download take", r.id, dl.error);
          continue;
        }
        const data = await decodeFlac(await dl.data.arrayBuffer(), r.meta.sampleRate);
        await putTakeRaw({ ...r.meta, id: r.id, data });
        b.uploaded[r.id] = 1;
        b.takeAt[r.id] = at;
        takesChanged.add(r.meta.projectId);
      } else {
        b.uploaded[r.id] = 1;
        if (at > (b.takeAt[r.id] ?? 0) && !((pending.takes[r.id] ?? 0) > at)) {
          const t = await getTake(r.id);
          if (t) {
            await putTakeRaw({ ...t, ...r.meta, id: r.id, data: t.data });
            delete pending.takes[r.id];
            takesChanged.add(t.projectId);
          }
          b.takeAt[r.id] = at;
        }
      }
    }

    if (changed) {
      const projects = [...byId.values()];
      const currentId = projects.some((p) => p.id === local.currentId) ? local.currentId : projects[0]?.id ?? null;
      writeProjectsRaw(projects, currentId);
      lastIds = new Set(projects.map((p) => p.id));
    }
    savePending();
    saveBook();
    if (changed || takesChanged.size) pulled = { projects: [...byId.values()], takesChanged };
  }

  // ----- push -----
  if (!b.seeded && kind === "full") {
    // first time this user syncs from this browser: everything local goes up
    const now = Date.now();
    for (const id of await getTakeIds()) if (!pending.takeTombs[id]) pending.takes[id] ??= now;
  }

  const locals = loadProjects().projects;
  const dirty = locals.filter((p) => b.projAt[p.id] !== p.updatedAt);
  if (dirty.length) {
    const rows = dirty.map((p) => ({ id: p.id, user_id: uid, data: p, updated_at: p.updatedAt, deleted: false }));
    const { error } = await c.from("projects").upsert(rows);
    if (error) throw error;
    dirty.forEach((p) => (b.projAt[p.id] = p.updatedAt));
    saveBook();
  }
  for (const [id, at] of Object.entries(pending.projTombs)) {
    const { error } = await c.from("projects").upsert({ id, user_id: uid, data: null, updated_at: at, deleted: true });
    if (error) throw error;
    b.projAt[id] = at;
    delete pending.projTombs[id];
    savePending();
    saveBook();
  }

  for (const [id, at] of Object.entries(pending.takes)) {
    const t = await getTake(id);
    if (!t) {
      delete pending.takes[id];
      savePending();
      continue;
    }
    if (!b.uploaded[id]) {
      const flac = encodeFlac(t.data, t.sampleRate);
      const up = await c.storage.from("takes").upload(objPath(uid, id), new Blob([flac as BlobPart], { type: "audio/flac" }), { upsert: true, contentType: "audio/flac" });
      if (up.error) throw up.error;
      b.uploaded[id] = 1;
      saveBook();
    }
    const { error } = await c.from("takes").upsert({ id, user_id: uid, project_id: t.projectId, meta: metaOf(t), updated_at: at, deleted: false });
    if (error) throw error;
    b.takeAt[id] = at;
    if (pending.takes[id] === at) delete pending.takes[id]; // unless edited again meanwhile
    savePending();
    saveBook();
  }

  for (const [id, at] of Object.entries(pending.takeTombs)) {
    const { error } = await c.from("takes").upsert({ id, user_id: uid, updated_at: at, deleted: true });
    if (error) throw error;
    await c.storage.from("takes").remove([objPath(uid, id)]); // best effort; the tombstone is what counts
    delete b.uploaded[id];
    b.takeAt[id] = at;
    delete pending.takeTombs[id];
    savePending();
    saveBook();
  }

  if (kind === "full") b.seeded = true;
  b.lastSync = Date.now();
  saveBook();
  set({ status: isEmpty(pending.takes) && isEmpty(pending.projTombs) && isEmpty(pending.takeTombs) ? "idle" : "syncing", lastSync: b.lastSync, error: undefined });
  if (pulled) onPullCb?.(pulled);
}

// ---------- public API ----------
export const cloud = {
  enabled,
  /** Load the client and restore the session. Safe to call more than once; no-op without config. */
  start,
  signInWithGoogle,
  sendMagicLink,
  signOut,
  syncNow: () => schedule("full", 0),
  getState: () => state,
  subscribe,
  /** Called after a pull changed local projects or takes. */
  onPull(cb: (r: PullResult) => void) {
    onPullCb = cb;
    return () => {
      if (onPullCb === cb) onPullCb = null;
    };
  },
};

export function useCloud(): CloudState {
  return useSyncExternalStore(subscribe, () => state);
}
