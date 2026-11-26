import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { askConfirm, askText, DialogHost, notify } from "./dialog";
import { INSTRUMENTS, instrumentalKey, isRendered, Player, renderInstrumental, STYLES, type Options, type Style } from "./engine";
import { Logo } from "./Logo";
import {
  DEFAULT_MIX,
  DEFAULT_VOICE,
  download,
  PURE_VOICE,
  renderMix,
  renderVocalStem,
  VOICE_PRESETS,
  voiceFromPreset,
  wav16,
  zip,
  type MixSettings,
  type VocalClip,
  type Voice,
} from "./mix";
import { Rail, SOON_COPY, type Page } from "./Rail";
import {
  BEATS_PER_BAR,
  beatsToSeconds,
  flame,
  fmtTime,
  isValidChord,
  layout,
  parseChordMap,
  PRESETS,
  sectionHint,
  serializeSong,
  STARTERS,
  type Song,
  type Starter,
} from "./song";
import {
  deleteTake,
  getTakes,
  loadProjects,
  loadSync,
  putTake,
  saveProjects,
  saveSync,
  takeOffset,
  takeVoice,
  uid,
  type Project,
  type Take,
} from "./store";
import { transposeSong } from "./theory";
import { ChordInput, Chips, Fader, Label, PauseIcon, PlayIcon, StartIcon, Stepper, StopIcon } from "./ui";
import { autotune, detectScale, MicRecorder, runSyncTest, SYNC_CLICKS } from "./vocal";

const DEFAULT_OPTS: Options = {
  instrument: "piano",
  style: "ballad",
  bass: true,
  drums: true,
  buildUp: true,
  reverb: 0.35,
  levels: { harmony: 0.9, bass: 0.7, drums: 0.55 },
};

// Warm, low-chroma section tints so the strip reads as one palette with the sun-yellow accent.
const TINTS = ["#FFC21A", "#F5A524", "#E8D7A8", "#C98A3B", "#FFE58A", "#B8A27A", "#F0B75E", "#D9C38F"];

function projectFrom(name: string, s: Starter): Project {
  return {
    id: uid(),
    name,
    text: s.text.replace(/^title:.*$/m, `title: ${name}`),
    transpose: 0,
    opts: { ...DEFAULT_OPTS, instrument: s.instrument, style: s.style },
    mix: DEFAULT_MIX,
    selectedTake: null,
    updatedAt: Date.now(),
  };
}

const boot = (() => {
  const s = loadProjects();
  if (s.projects.length && s.projects.some((p) => p.id === s.currentId)) return s;
  if (s.projects.length) return { projects: s.projects, currentId: s.projects[0].id };
  const p = projectFrom("Aaina", STARTERS.find((x) => x.id === "aaina")!);
  return { projects: [p], currentId: p.id };
})();
const bootProject = boot.projects.find((p) => p.id === boot.currentId)!;
const bootParse = parseChordMap(bootProject.text);

const safe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim() || "song";
const bpmOf = (text: string) => Number(text.match(/^tempo:\s*(\d+)/m)?.[1] ?? 90);

type SyncState = { phase: "intro" | "running" | "done" | "fail"; click: number; result?: number; thenRecord?: number };

export default function App() {
  // ---------- project ----------
  const [projects, setProjects] = useState<Project[]>(boot.projects);
  const [currentId, setCurrentId] = useState<string>(boot.currentId!);
  const project = projects.find((p) => p.id === currentId)!;

  const [song, setSong] = useState<Song>(bootParse.song);
  const [text, setText] = useState(bootProject.text);
  const [warnings, setWarnings] = useState<string[]>(bootParse.warnings);
  const [dirty, setDirty] = useState(false);
  const [opts, setOpts] = useState<Options>(bootProject.opts);
  const [transpose, setTranspose] = useState(bootProject.transpose);
  const [mix, setMix] = useState<MixSettings>(bootProject.mix);
  const [selectedTake, setSelectedTake] = useState<string | null>(bootProject.selectedTake);
  const [takes, setTakes] = useState<Take[]>([]);
  const [pending, setPending] = useState<Take | null>(null);
  // Play the band alone, or the band with the picked take singing along.
  const [withVocal, setWithVocal] = useState(false);

  // ---------- app ----------
  const [page, setPage] = useState<Page>("home");
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [beat, setBeat] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  const [loopBlock, setLoopBlock] = useState<number | null>(null);
  const [sideTab, setSideTab] = useState<"sound" | "map">("sound");
  const [busy, setBusy] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const [sync, setSync] = useState<number | null>(loadSync());
  const [syncUi, setSyncUi] = useState<SyncState | null>(null);
  const skippedSync = useRef(false);

  const playerRef = useRef<Player | null>(null);
  const player = useMemo(() => (playerRef.current ??= new Player(DEFAULT_OPTS)), []);
  const recorder = useMemo(() => new MicRecorder(player.ctx), [player]);

  const played = useMemo(() => transposeSong(song, transpose), [song, transpose]);
  const { blocks, totalBeats } = useMemo(() => layout(played), [played]);
  const totalSec = beatsToSeconds(totalBeats, song.bpm);
  const scale = useMemo(() => detectScale(played.sections.flatMap((s) => s.chords.map((c) => c.symbol))), [played]);

  useEffect(() => player.setSong(blocks, totalBeats), [player, blocks, totalBeats]);
  useEffect(() => player.setBpm(song.bpm), [player, song.bpm]);
  useEffect(() => player.setOptions(opts), [player, opts]);
  useEffect(() => player.setMix(mix), [player, mix]);
  useEffect(() => {
    const b = loopBlock !== null && !recording ? blocks[loopBlock] : undefined;
    player.setLoop(b ? { start: b.startBeat, end: b.startBeat + b.beats } : null);
  }, [player, blocks, loopBlock, recording]);

  // persist project edits
  useEffect(() => {
    const t = setTimeout(() => {
      setProjects((ps) => {
        const next = ps.map((p) => (p.id === currentId ? { ...p, text, opts, transpose, mix, selectedTake, updatedAt: Date.now() } : p));
        saveProjects(next, currentId);
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [currentId, text, opts, transpose, mix, selectedTake]);

  useEffect(() => {
    let live = true;
    getTakes(currentId).then((t) => live && setTakes(t));
    return () => {
      live = false;
    };
  }, [currentId]);

  useEffect(() => {
    setLoading(bootProject.opts.instrument);
    player.load(bootProject.opts.instrument).finally(() => setLoading(null));
  }, [player]);

  // ---------- the take that sings along ----------
  const tunedCache = useRef(new Map<string, Float32Array>());
  const activeTake = pending ?? takes.find((t) => t.id === selectedTake) ?? null;
  const voiceOf = useCallback((t: Take) => takeVoice(t, project.legacyMix), [project.legacyMix]);
  const activeVoice = activeTake ? voiceOf(activeTake) : DEFAULT_VOICE;

  const clipFor = useCallback(
    (take: Take, voice: Voice): VocalClip => {
      let data = take.data;
      if (voice.tune > 0) {
        const key = `${take.id}|${scale.join(",")}|${voice.tune}`;
        let d = tunedCache.current.get(key);
        if (!d) {
          d = autotune(take.data, take.sampleRate, scale, voice.tune);
          tunedCache.current.set(key, d);
        }
        data = d;
      }
      return { data, sampleRate: take.sampleRate, offset: takeOffset(take, sync) };
    },
    [scale, sync],
  );

  useEffect(() => player.setVoice(activeVoice), [player, activeVoice]);

  useEffect(() => {
    if (recording || !activeTake || !withVocal) {
      player.setVocal(null);
      return;
    }
    let cancelled = false;
    const needsTune = activeVoice.tune > 0;
    if (needsTune) setTuning(true);
    const t = setTimeout(() => {
      if (cancelled) return;
      player.setVocal(clipFor(activeTake, activeVoice));
      setTuning(false);
    }, needsTune ? 30 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, activeTake?.id, activeTake?.nudgeMs, recording, withVocal, activeVoice.tune, clipFor]);

  // per-take edits (voice, nudge, name) save quietly in the background
  const saveTimers = useRef(new Map<string, number>());
  const updateTake = (id: string, patch: Partial<Take>) => {
    if (pending?.id === id) return setPending({ ...pending, ...patch });
    setTakes((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch };
        clearTimeout(saveTimers.current.get(id));
        saveTimers.current.set(id, window.setTimeout(() => putTake(next), 400));
        return next;
      }),
    );
  };
  const setVoice = (v: Voice) => activeTake && updateTake(activeTake.id, { voice: v });

  // ---------- background pre-render so export is instant ----------
  const instKey = instrumentalKey(blocks, song.bpm, opts);
  useEffect(() => {
    if (isRendered(blocks, song.bpm, opts)) {
      renderInstrumental(blocks, totalBeats, song.bpm, opts).then(() => setRenderedKey(instKey));
      return;
    }
    if (playing || recording) return;
    const t = setTimeout(() => {
      renderInstrumental(blocks, totalBeats, song.bpm, opts).then(() => setRenderedKey(instKey)).catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instKey, playing, recording]);
  const instReady = renderedKey === instKey;

  // ---------- playhead ----------
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setBeat(player.getBeat());
      if (recording) setMicLevel(recorder.level);
      raf = requestAnimationFrame(loop);
    };
    if (playing) raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player, recorder, playing, recording]);

  // ---------- recording ----------
  const recMeta = useRef<{ time: number; beat: number; bpm: number } | null>(null);

  const finishRecording = () => {
    const meta = recMeta.current;
    recMeta.current = null;
    setRecording(false);
    setMicLevel(0);
    const r = recorder.stop();
    if (!r || !meta) return;
    const sr = player.ctx.sampleRate;
    // Measured sync beats the browser's own latency guess every time.
    const latency = sync ?? recorder.roundTripLatency();
    let offset = beatsToSeconds(meta.beat, meta.bpm) + (r.t0 - meta.time) - latency;
    let data = r.data;
    if (offset < 0) {
      const cut = Math.ceil(-offset * sr);
      data = data.slice(cut);
      offset += cut / sr;
    }
    if (data.length < sr * 0.5) return; // ignore accidental taps
    setPending({
      id: uid(),
      projectId: currentId,
      name: `Take ${takes.length + 1}`,
      createdAt: Date.now(),
      sampleRate: sr,
      offset,
      latencyUsed: latency,
      nudgeMs: 0,
      voice: activeTake ? voiceOf(activeTake) : DEFAULT_VOICE,
      bpm: meta.bpm,
      data,
    });
  };
  const finishRef = useRef(finishRecording);
  finishRef.current = finishRecording;

  useEffect(() => {
    player.onEnd = () => {
      setPlaying(false);
      setBeat(0);
      if (recMeta.current) finishRef.current();
    };
  }, [player]);

  const startRecording = async (fromBeat: number) => {
    if (recording) return stopAll();
    // First time on this device: offer the 10-second sync test so takes land exactly on the beat.
    if (sync === null && !skippedSync.current) {
      setSyncUi({ phase: "intro", click: -1, thenRecord: fromBeat });
      return;
    }
    if (player.playing) player.pause();
    setPending(null);
    try {
      setBusy("Waiting for the microphone…");
      await recorder.init();
    } catch (e) {
      notify("Microphone blocked", "Allow mic access for this site in your browser’s address bar, then try again. (" + (e as Error).message + ")");
      return;
    } finally {
      setBusy(null);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    player.setVocal(null);
    setRecording(true);
    recorder.start();
    setLoading(opts.instrument);
    const anchor = await player.play(fromBeat);
    setLoading(null);
    recMeta.current = { ...anchor, bpm: song.bpm };
    setPlaying(true);
  };

  const runSync = async () => {
    if (player.playing) stopAll();
    setSyncUi((s) => ({ ...(s ?? { phase: "intro" }), phase: "running", click: -1 }));
    try {
      const r = await runSyncTest(player.ctx, recorder, (i) => setSyncUi((s) => (s ? { ...s, click: i } : s)));
      if (!r) return setSyncUi((s) => (s ? { ...s, phase: "fail" } : s));
      setSync(r.latency);
      saveSync(r.latency);
      setSyncUi((s) => (s ? { ...s, phase: "done", result: r.latency } : s));
    } catch (e) {
      setSyncUi(null);
      notify("Microphone blocked", "Allow mic access for this site in your browser’s address bar, then try again. (" + (e as Error).message + ")");
    }
  };

  const closeSync = (thenRecord?: number) => {
    setSyncUi(null);
    if (thenRecord !== undefined) setTimeout(() => startRecording(thenRecord), 50);
  };

  // ---------- transport ----------
  const stopAll = () => {
    const wasRecording = !!recMeta.current;
    player.pause();
    setPlaying(false);
    setBeat(player.getBeat());
    if (wasRecording) finishRecording();
  };

  const togglePlay = useCallback(async () => {
    if (recMeta.current) return stopAll();
    if (player.playing) {
      player.pause();
      setPlaying(false);
      setBeat(player.getBeat());
    } else {
      setLoading(opts.instrument);
      await player.play();
      setLoading(null);
      setPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, opts.instrument]);

  /** Band-only and with-vocal are separate buttons: each pauses its own mode, or switches mode mid-song. */
  const playMode = async (vocal: boolean) => {
    if (recMeta.current) return stopAll();
    if (player.playing && withVocal === vocal) {
      player.pause();
      setPlaying(false);
      setBeat(player.getBeat());
      return;
    }
    setWithVocal(vocal);
    if (!player.playing) {
      setLoading(opts.instrument);
      await player.play();
      setLoading(null);
      setPlaying(true);
    }
  };

  const playFromStart = async () => {
    if (recMeta.current) stopAll();
    if (player.playing) return seek(0);
    setLoading(opts.instrument);
    await player.play(0);
    setLoading(null);
    setPlaying(true);
  };

  const backToStart = () => {
    if (recMeta.current) stopAll();
    player.stop();
    setPlaying(false);
    setBeat(0);
  };

  const seek = (b: number) => {
    if (recMeta.current) return;
    player.seek(b);
    setBeat(b);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["TEXTAREA", "INPUT", "SELECT"].includes(t.tagName) || document.querySelector(".dlg-backdrop")) return;
      if (e.code === "Space" && ["compose", "record", "mix"].includes(page)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, page]);

  // ---------- takes ----------
  const keepTake = async () => {
    if (!pending) return;
    await putTake(pending);
    setTakes((t) => [...t, pending]);
    setSelectedTake(pending.id);
    setPending(null);
  };

  const removeTake = async (t: Take) => {
    if (!(await askConfirm(`Delete “${t.name}”?`, "This take will be gone for good. Download it first if you might want it later."))) return;
    await deleteTake(t.id);
    setTakes((ts) => ts.filter((x) => x.id !== t.id));
    if (selectedTake === t.id) setSelectedTake(null);
  };

  const listenTo = async (t: Take) => {
    if (t.id !== pending?.id) setSelectedTake(t.id);
    setWithVocal(true);
    const songBeat = (takeOffset(t, sync) * song.bpm) / 60;
    const c = blocks.flatMap((b) => b.chords).filter((ch) => ch.startBeat <= songBeat + 0.01).at(-1);
    const from = c ? c.startBeat : 0;
    setLoading(opts.instrument);
    if (player.playing) player.seek(from);
    else await player.play(from);
    setLoading(null);
    setPlaying(true);
  };

  // ---------- exports ----------
  const base = safe(project.name);
  const withBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      notify("Export didn’t finish", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const instBuffer = () => renderInstrumental(blocks, totalBeats, song.bpm, opts);

  const exportInstrumental = () =>
    withBusy(instReady ? "Encoding…" : "Rendering instrumental…", async () => {
      download(wav16(await instBuffer()), `${base} - instrumental.wav`);
    });

  const exportVocal = (t: Take | null, dry: boolean) =>
    withBusy("Rendering vocal…", async () => {
      if (!t) throw new Error("Record and keep a take first");
      const v = dry ? PURE_VOICE : voiceOf(t);
      const buf = await renderVocalStem(clipFor(t, v), v, dry ? 1 : mix.vocal, song.bpm, totalSec + 3);
      download(wav16(buf), `${base} - vocal ${dry ? "dry" : "fx"} - ${safe(t.name)}.wav`);
    });

  const exportMix = () =>
    withBusy("Mixing…", async () => {
      const buf = await renderMix(await instBuffer(), activeTake ? clipFor(activeTake, activeVoice) : null, activeVoice, mix, song.bpm);
      download(wav16(buf), `${base} - mix${activeTake ? " - " + safe(activeTake.name) : ""}.wav`);
    });

  const exportPack = () =>
    withBusy("Building pack…", async () => {
      const inst = await instBuffer();
      const files: Record<string, Uint8Array> = { [`${base}/instrumental.wav`]: wav16(inst) };
      if (activeTake) {
        const c = clipFor(activeTake, activeVoice);
        files[`${base}/vocal fx - ${safe(activeTake.name)}.wav`] = wav16(await renderVocalStem(c, activeVoice, mix.vocal, song.bpm, totalSec + 3));
        files[`${base}/mix - ${safe(activeTake.name)}.wav`] = wav16(await renderMix(inst, c, activeVoice, mix, song.bpm));
      }
      for (const t of takes)
        files[`${base}/takes (dry)/${safe(t.name)}.wav`] = wav16(await renderVocalStem(clipFor(t, PURE_VOICE), PURE_VOICE, 1, song.bpm, totalSec + 3));
      files[`${base}/chords.txt`] = new TextEncoder().encode(text);
      download(zip(files), `${base} - pack.zip`, "application/zip");
    });

  // ---------- song editing ----------
  const pickInstrument = async (id: string) => {
    const def = INSTRUMENTS.find((i) => i.id === id)!;
    setLoading(id);
    try {
      await player.load(id);
      setOpts((o) => ({ ...o, instrument: id, style: def.style }));
    } finally {
      setLoading(null);
    }
  };

  const commitSong = (next: Song) => {
    setSong(next);
    setText(serializeSong(next));
    setDirty(false);
  };

  const applyText = (t = text) => {
    const r = parseChordMap(t);
    if (r.song.sections.length === 0) {
      setWarnings(["No chords found. Put chords under a [Section] header."]);
      return;
    }
    setSong(r.song);
    setText(t);
    setWarnings(r.warnings);
    setDirty(false);
    setLoopBlock(null);
    seek(0);
  };

  const onUpload = async (file: File) => {
    applyText(await file.text());
    setSideTab("map");
  };

  const editChord = (fn: (s: Song) => void) => {
    const next = structuredClone(song);
    fn(next);
    commitSong(next);
  };

  // ---------- projects ----------
  const openProject = (id: string, list = projects, to: Page = "compose") => {
    const p = list.find((x) => x.id === id);
    if (!p) return;
    if (id !== currentId) {
      if (recMeta.current) stopAll();
      player.stop();
      setPlaying(false);
      setBeat(0);
      const r = parseChordMap(p.text);
      setCurrentId(id);
      setSong(r.song);
      setText(p.text);
      setWarnings(r.warnings);
      setDirty(false);
      setOpts(p.opts);
      setTranspose(p.transpose);
      setMix({ ...DEFAULT_MIX, ...p.mix });
      setSelectedTake(p.selectedTake);
      setPending(null);
      setLoopBlock(null);
      setTakes([]);
      setLoading(p.opts.instrument);
      player.load(p.opts.instrument).finally(() => setLoading(null));
    }
    setPage(to);
  };

  const createProject = (name: string, starter: Starter) => {
    const p = projectFrom(name, starter);
    const next = [...projects, p];
    setProjects(next);
    saveProjects(next, currentId);
    openProject(p.id, next, "compose");
  };

  const renameProject = async (target: Project = project) => {
    const name = await askText("Rename song", target.name, { confirm: "Rename" });
    if (!name || name === target.name) return;
    const retitle = (t: string) => (/^title:/m.test(t) ? t.replace(/^title:.*$/m, `title: ${name}`) : `title: ${name}\n${t}`);
    setProjects((ps) => {
      const next = ps.map((p) => (p.id === target.id ? { ...p, name, text: p.id === currentId ? p.text : retitle(p.text) } : p));
      saveProjects(next, currentId);
      return next;
    });
    if (target.id === currentId) applyText(retitle(text));
  };

  const removeProject = async (p: Project) => {
    if (projects.length <= 1) return;
    const ok = await askConfirm(
      `Delete “${p.name}”?`,
      "Its chords, settings and every take will be deleted from this browser. Export a pack first if you want to keep anything.",
      "Delete song",
    );
    if (!ok) return;
    const ts = p.id === currentId ? takes : await getTakes(p.id);
    await Promise.all(ts.map((t) => deleteTake(t.id)));
    const rest = projects.filter((x) => x.id !== p.id);
    if (p.id === currentId) openProject(rest[0].id, rest, "home");
    setProjects(rest);
    saveProjects(rest, p.id === currentId ? rest[0].id : currentId);
  };

  const go = (p: Page) => {
    setPage(p);
    window.scrollTo({ top: 0 });
  };

  // ---------- derived view state ----------
  const block = blocks.find((b) => beat >= b.startBeat && beat < b.startBeat + b.beats) ?? blocks[0];
  const chordIdx = block ? block.chords.findIndex((c) => beat >= c.startBeat && beat < c.startBeat + c.beats) : -1;
  const chord = block?.chords[Math.max(0, chordIdx)];
  const flatAll = blocks.flatMap((b) => b.chords);
  const flatIdx = chord ? flatAll.indexOf(chord) : -1;
  const nextChord = flatAll[flatIdx + 1];
  const beatInBar = Math.floor(beat % BEATS_PER_BAR);
  const chordProgress = chord ? Math.min(1, (beat - chord.startBeat) / chord.beats) : 0;
  const instrumentDef = INSTRUMENTS.find((i) => i.id === opts.instrument)!;
  const recSeconds = recMeta.current ? beatsToSeconds(beat - recMeta.current.beat, song.bpm) : 0;
  const studio = page === "compose" || page === "record" || page === "mix";

  return (
    <div className="shell">
      <DialogHost />
      <Rail page={page} onGo={go} recording={recording} />
      {syncUi && <SyncModal s={syncUi} onRun={runSync} onClose={closeSync} />}

      <div className="app">
        {page === "home" && (
          <HomePage
            projects={projects}
            currentId={currentId}
            onOpen={(id) => openProject(id)}
            onCreate={() => go("create")}
            onDelete={removeProject}
            onRename={renameProject}
          />
        )}

        {page === "create" && <CreatePage onCreate={createProject} onCancel={() => go("home")} />}

        {page === "settings" && (
          <SettingsPage
            sync={sync}
            onRun={() => setSyncUi({ phase: "intro", click: -1 })}
            onReset={() => {
              setSync(null);
              saveSync(null);
            }}
          />
        )}

        {(page === "lyrics" || page === "hum" || page === "community") && (
          <section className="soon-page">
            <span className="soon-tag">Coming soon</span>
            <h1>{SOON_COPY[page].title}</h1>
            <p>{SOON_COPY[page].body}</p>
            <button className="primary" onClick={() => go("compose")}>
              Back to {project.name}
            </button>
          </section>
        )}

        {studio && (
          <>
            <header className="top">
              <button className="song-name" onClick={() => renameProject()} title="Rename song">
                <span className="lbl">Song</span>
                <b>{project.name}</b>
                <PencilIcon />
              </button>
              <div className="top-meta">
                <span>{fmtTime(totalSec)}</span>
                <span className="sep">/</span>
                <span>
                  {takes.length} take{takes.length === 1 ? "" : "s"}
                </span>
              </div>
              <button className="ghost" onClick={exportInstrumental} disabled={!!busy}>
                {busy ?? (instReady ? "Export instrumental ⚡" : "Export instrumental")}
              </button>
            </header>

            <section className={`hero ${playing ? "is-playing" : ""} ${recording ? "is-rec" : ""}`}>
              <div className="glow" style={{ ["--pulse" as string]: playing ? (beatInBar === 0 ? 1 : 0.55) : 0.35 }}>
                <i className="g1" />
                <i className="g2" />
                <i className="g3" />
              </div>
              <div className="hero-inner">
                <div className="now">
                  <div className="eyebrow">
                    {recording && <span className="rec-pill">● REC {fmtTime(recSeconds)}</span>}
                    {block?.name ?? "—"}
                    {loopBlock !== null && !recording && <span className="tag">LOOP</span>}
                  </div>
                  <div className="big-chord" key={chord ? `${flatIdx}` : "none"}>
                    {chord?.symbol ?? "—"}
                  </div>
                  <div className="next">
                    <span>next</span> {nextChord?.symbol ?? "end"}
                  </div>
                  <div className="beats">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} className={playing && i === beatInBar ? "on" : ""} />
                    ))}
                  </div>
                </div>

                <div className="transport">
                  <button className="round" onClick={playFromStart} title="Play from the beginning" aria-label="Play from start">
                    <StartIcon />
                  </button>
                  <button
                    className="play"
                    onClick={() => playMode(false)}
                    disabled={!!loading && !playing}
                    aria-label={playing && !withVocal ? "Pause" : "Play the band"}
                    title="Play the band only (space pauses)"
                  >
                    {loading && !playing ? <span className="spin" /> : playing && !withVocal ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <button className="round" onClick={backToStart} aria-label="Stop" title="Stop and go back to the start">
                    <StopIcon />
                  </button>
                  {activeTake && !recording && (
                    <button className={`vox ${playing && withVocal ? "on" : ""}`} onClick={() => playMode(true)} title={`Play the band with ${activeTake.name}`}>
                      {playing && withVocal ? <PauseIcon /> : <PlayIcon />}
                      <span>
                        <small>with</small>
                        {activeTake.name}
                      </span>
                    </button>
                  )}
                  <div className="rec-group">
                    <button className={`rec ${recording ? "live" : ""}`} onClick={() => startRecording(0)} disabled={!!busy}>
                      <i style={{ ["--lvl" as string]: micLevel }} />
                      {recording ? "Stop take" : "Rec from start"}
                    </button>
                    {!recording && (
                      <button className="rec alt" onClick={() => startRecording(Math.floor(beat / BEATS_PER_BAR) * BEATS_PER_BAR)} disabled={!!busy}>
                        <i />
                        Rec from here
                      </button>
                    )}
                  </div>
                  <div className="readout">
                    <div className="time">
                      {fmtTime(beatsToSeconds(beat, song.bpm))}
                      <span> / {fmtTime(totalSec)}</span>
                    </div>
                    <div className="sub">
                      {instrumentDef.label} · {STYLES.find((s) => s.id === opts.style)?.label}
                      {activeTake && !recording && withVocal && (
                        <>
                          {" "}
                          · 🎤 {activeTake.name}
                          {tuning ? " (tuning…)" : ""}
                        </>
                      )}
                      {loading && <em> · loading {INSTRUMENTS.find((i) => i.id === loading)?.label.toLowerCase()}…</em>}
                    </div>
                  </div>
                  <Stepper label="Tempo" value={song.bpm} unit="bpm" step={2} onChange={(v) => commitSong({ ...song, bpm: Math.max(40, Math.min(220, v)) })} />
                  <Stepper label="Key" value={transpose} unit="st" signed step={1} onChange={(v) => setTranspose(Math.max(-11, Math.min(11, v)))} />
                </div>
              </div>

              <Strip
                blocks={blocks}
                totalBeats={totalBeats}
                beat={beat}
                bpm={song.bpm}
                loopBlock={loopBlock}
                takeSpan={activeTake && !recording && withVocal ? [takeOffset(activeTake, sync), takeOffset(activeTake, sync) + activeTake.data.length / activeTake.sampleRate] : null}
                totalSec={totalSec}
                onSeek={seek}
                onLoop={(i) => setLoopBlock((cur) => (cur === i ? null : i))}
              />
            </section>

            {pending && (
              <div className="pending">
                <div>
                  <b>New take · {fmtTime(pending.data.length / pending.sampleRate)}</b>
                  <span>Press ▶ Listen to hear it with the band, then keep or toss it.</span>
                </div>
                <button className="ghost" onClick={() => listenTo(pending)}>
                  ▶ Listen
                </button>
                <button className="ghost" onClick={() => setPending(null)}>
                  Discard
                </button>
                <button className="primary" onClick={keepTake}>
                  Keep take
                </button>
              </div>
            )}
          </>
        )}

        {page === "compose" && (
          <main className="grid">
            <section className="panel sections">
              <div className="panel-head">
                <h2>Chords</h2>
                <p>Each tile is one chord. Use − and + to make it ring longer or shorter ({beatsToSeconds(4, song.bpm).toFixed(1)}s per bar). Click a chord to change it.</p>
              </div>
              {song.sections.map((s, si) => (
                <div className="sec" key={s.name + si}>
                  <div className="sec-name">
                    <i style={{ background: TINTS[si % TINTS.length] }} />
                    {s.name}
                    {sectionHint(s.name) && <span className="sec-hint">{sectionHint(s.name)}</span>}
                    <button className="add" onClick={() => editChord((n) => n.sections[si].chords.push({ symbol: s.chords.at(-1)?.symbol ?? "C", bars: 1 }))}>
                      + chord
                    </button>
                  </div>
                  <div className="tiles">
                    {s.chords.map((c, ci) => {
                      const active = !!block && block.sectionIndex === si && chordIdx === ci;
                      const shown = played.sections[si].chords[ci].symbol;
                      return (
                        <div className={`tile ${active ? "active" : ""} ${isValidChord(c.symbol) ? "" : "bad"}`} key={ci} style={{ flexGrow: c.bars }}>
                          {active && <div className="fill" style={{ width: `${chordProgress * 100}%` }} />}
                          <ChordInput value={c.symbol} shown={shown} onCommit={(v) => editChord((n) => (n.sections[si].chords[ci].symbol = v))} />
                          <div className="dur">
                            <button onClick={() => editChord((n) => (n.sections[si].chords[ci].bars = Math.max(0.5, c.bars - 0.5)))}>−</button>
                            <span>
                              {c.bars} bar{c.bars === 1 ? "" : "s"}
                              <em>{beatsToSeconds(c.bars * 4, song.bpm).toFixed(1)}s</em>
                            </span>
                            <button onClick={() => editChord((n) => (n.sections[si].chords[ci].bars = Math.min(8, c.bars + 0.5)))}>+</button>
                          </div>
                          <button className="x" onClick={() => s.chords.length > 1 && editChord((n) => n.sections[si].chords.splice(ci, 1))} aria-label="Remove chord">
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>

            <aside className="panel side">
              <div className="tabs">
                <button className={sideTab === "sound" ? "on" : ""} onClick={() => setSideTab("sound")}>
                  Sound
                </button>
                <button className={sideTab === "map" ? "on" : ""} onClick={() => setSideTab("map")}>
                  Paste / upload
                </button>
              </div>

              {sideTab === "sound" ? (
                <div className="sound">
                  <Label>Instrument</Label>
                  <div className="inst-grid">
                    {INSTRUMENTS.map((i) => (
                      <button key={i.id} className={`inst ${opts.instrument === i.id ? "on" : ""}`} onClick={() => pickInstrument(i.id)} disabled={!!loading}>
                        <b>{i.label}</b>
                        <span>{loading === i.id ? "loading…" : i.note}</span>
                      </button>
                    ))}
                  </div>
                  <Label>Feel</Label>
                  <Chips value={opts.style} options={STYLES} onChange={(s) => setOpts({ ...opts, style: s as Style })} />
                  <Label>Band</Label>
                  <div className="mixer">
                    <Fader label={instrumentDef.label} value={opts.levels.harmony} onChange={(v) => setOpts({ ...opts, levels: { ...opts.levels, harmony: v } })} />
                    <Fader
                      label="Bass"
                      value={opts.levels.bass}
                      enabled={opts.bass}
                      onToggle={() => setOpts({ ...opts, bass: !opts.bass })}
                      onChange={(v) => setOpts({ ...opts, levels: { ...opts.levels, bass: v } })}
                    />
                    <Fader
                      label="Drums"
                      value={opts.levels.drums}
                      enabled={opts.drums}
                      onToggle={() => setOpts({ ...opts, drums: !opts.drums })}
                      onChange={(v) => setOpts({ ...opts, levels: { ...opts.levels, drums: v } })}
                    />
                    <Fader label="Room" value={opts.reverb} onChange={(v) => setOpts({ ...opts, reverb: v })} />
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={opts.buildUp} onChange={() => setOpts({ ...opts, buildUp: !opts.buildUp })} />
                    Build-up: drums wait until after the first section
                  </label>
                </div>
              ) : (
                <div className="map">
                  <div className="presets">
                    {PRESETS.map((p) => (
                      <button key={p.name} onClick={() => applyText(p.text.replace(/^title:.*$/m, `title: ${project.name}`))}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <textarea
                    spellCheck={false}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <div className="map-actions">
                    <button className="primary" onClick={() => applyText()} disabled={!dirty}>
                      {dirty ? "Build song" : "Up to date"}
                    </button>
                    <label className="ghost upload">
                      Upload .txt / .json
                      <input type="file" accept=".txt,.json,.md,text/plain,application/json" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
                    </label>
                  </div>
                  {warnings.length > 0 && (
                    <ul className="warn">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  <details className="help">
                    <summary>Format</summary>
                    <pre>{`title: My Song
tempo: 80

[Mukhda]
Am  Fmaj7  C  G       one bar each
Am(2)  G(1/2) F(1/2)  (n) = bars
%                     repeat last chord
N.C.                  silence

structure: Mukhda x2, Antara, Mukhda`}</pre>
                  </details>
                </div>
              )}
            </aside>
          </main>
        )}

        {page === "record" && (
          <main className="grid">
            <section className="panel">
              <div className="panel-head">
                <h2>Takes</h2>
                <p>Pick a take to hear it with the band and shape its sound on the right. Every take keeps its own settings.</p>
              </div>
              <SyncBadge sync={sync} onRun={() => setSyncUi({ phase: "intro", click: -1 })} />
              {takes.length === 0 && !pending && (
                <div className="empty">
                  <b>No takes yet.</b>
                  <span>Hit “Rec from start” and sing. Wired headphones on, so the band doesn’t leak into your mic.</span>
                </div>
              )}
              <div className="takes">
                {takes.map((t) => {
                  const v = voiceOf(t);
                  return (
                    <div key={t.id} className={`take ${selectedTake === t.id ? "on" : ""}`} onClick={() => setSelectedTake(t.id)}>
                      <span className="pick" />
                      <input
                        id={`take-name-${t.id}`}
                        className="take-name"
                        defaultValue={t.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => e.target.value.trim() && updateTake(t.id, { name: e.target.value.trim() })}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      />
                      <button
                        className="mini ghosty"
                        title="Rename take"
                        onClick={(e) => {
                          e.stopPropagation();
                          const el = document.getElementById(`take-name-${t.id}`) as HTMLInputElement | null;
                          el?.focus();
                          el?.select();
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <span className="take-meta">
                        {fmtTime(t.data.length / t.sampleRate)} · {VOICE_PRESETS.find((p) => p.id === v.preset)?.label}
                        {v.tune > 0 && " + tune"}
                        {t.bpm !== song.bpm && <em> · sung at {t.bpm} bpm</em>}
                      </span>
                      <button
                        className="mini"
                        onClick={(e) => {
                          e.stopPropagation();
                          listenTo(t);
                        }}
                        title="Play with the band"
                      >
                        ▶
                      </button>
                      <button
                        className="mini"
                        onClick={(e) => {
                          e.stopPropagation();
                          exportVocal(t, false);
                        }}
                        title="Download this vocal"
                      >
                        ⤓
                      </button>
                      <button
                        className="mini danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTake(t);
                        }}
                        title="Delete take"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            <aside className="panel side">
              {activeTake ? (
                <>
                  <VoicePanel take={activeTake} voice={activeVoice} tuning={tuning} onVoice={setVoice} onNudge={(ms) => updateTake(activeTake.id, { nudgeMs: ms })} />
                </>
              ) : (
                <div className="empty slim">
                  <b>Your voice</b>
                  <span>Record or pick a take to shape how it sounds: presets like Warm, Pop shine and Dreamy, plus auto-tune.</span>
                </div>
              )}
              <Label>Mic</Label>
              <div className="meter">
                <i style={{ width: `${Math.min(100, micLevel * 140)}%` }} />
              </div>
            </aside>
          </main>
        )}

        {page === "mix" && (
          <main className="grid">
            <section className="panel">
              <div className="panel-head">
                <h2>Mix & export</h2>
                <p>What you hear when you press play is exactly what gets exported.</p>
              </div>
              <Label>Vocal take</Label>
              <select className="select" value={selectedTake ?? ""} onChange={(e) => setSelectedTake(e.target.value || null)}>
                <option value="">No vocal (instrumental only)</option>
                {takes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {fmtTime(t.data.length / t.sampleRate)}
                  </option>
                ))}
              </select>
              <Label>Balance</Label>
              <div className="mixer">
                <Fader label="Band" value={mix.inst} max={1.2} onChange={(v) => setMix({ ...mix, inst: v })} />
                <Fader label="Vocal" value={mix.vocal} max={1.5} onChange={(v) => setMix({ ...mix, vocal: v })} />
              </div>
              <label className="check">
                <input type="checkbox" checked={mix.master} onChange={() => setMix({ ...mix, master: !mix.master })} />
                Master: make the whole song louder and more finished
              </label>

              <Label>Export</Label>
              <div className="exports">
                <button onClick={exportInstrumental} disabled={!!busy}>
                  <b>Instrumental {instReady && "⚡"}</b>
                  <span>Band only. Drop it into GarageBand.</span>
                </button>
                <button onClick={() => exportVocal(activeTake, false)} disabled={!!busy || !activeTake}>
                  <b>Vocal · with sound</b>
                  <span>Your take with its voice settings, starts at 0:00.</span>
                </button>
                <button onClick={() => exportVocal(activeTake, true)} disabled={!!busy || !activeTake}>
                  <b>Vocal · dry</b>
                  <span>Raw take for mixing elsewhere, starts at 0:00.</span>
                </button>
                <button onClick={exportMix} disabled={!!busy}>
                  <b>Full song</b>
                  <span>Band + vocal, mastered.</span>
                </button>
                <button className="wide" onClick={exportPack} disabled={!!busy}>
                  <b>Export everything (.zip)</b>
                  <span>Instrumental, vocal, full song, every take dry, and the chord sheet.</span>
                </button>
              </div>
              {busy && <p className="hint busy">{busy}</p>}
            </section>
            <aside className="panel side">
              {activeTake ? (
                <VoicePanel take={activeTake} voice={activeVoice} tuning={tuning} onVoice={setVoice} onNudge={(ms) => updateTake(activeTake.id, { nudgeMs: ms })} />
              ) : (
                <div className="empty slim">
                  <b>No vocal picked</b>
                  <span>Pick a take above to mix it with the band.</span>
                </div>
              )}
            </aside>
          </main>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pages

function HomePage(props: {
  projects: Project[];
  currentId: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (p: Project) => void;
  onRename: (p: Project) => void;
}) {
  const list = [...props.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <section className="page">
      <div className="page-head">
        <Logo size={56} />
        <div>
          <h1>Your songs</h1>
          <p>Bring the chords, we’ll bring the band. Then sing.</p>
        </div>
      </div>
      <div className="song-grid">
        <button className="song-card new" onClick={props.onCreate}>
          <span className="plus">+</span>
          <b>New song</b>
          <span>Pick a vibe, we set up the band</span>
        </button>
        {list.map((p) => {
          const bpm = bpmOf(p.text);
          const inst = INSTRUMENTS.find((i) => i.id === p.opts.instrument)?.label ?? "";
          const chords = (p.text.match(/^\[.+\]\s*\n(.+)$/m)?.[1] ?? "").trim().split(/\s+/).slice(0, 4);
          return (
            <div key={p.id} className={`song-card ${p.id === props.currentId ? "cur" : ""}`} style={{ ["--flame" as string]: flame(bpm) }} onClick={() => props.onOpen(p.id)}>
              <div className="card-glow" />
              <div className="card-chords">
                {chords.map((c, i) => (
                  <span key={i}>{c.replace(/\(.*\)/, "")}</span>
                ))}
              </div>
              <b>{p.name}</b>
              <span>
                {bpm} bpm · {inst}
              </span>
              <div className="card-actions">
                <button
                  title="Rename song"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onRename(p);
                  }}
                >
                  <PencilIcon />
                </button>
                {props.projects.length > 1 && (
                  <button
                    className="del"
                    title="Delete song"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDelete(p);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CreatePage({ onCreate, onCancel }: { onCreate: (name: string, s: Starter) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [pick, setPick] = useState(STARTERS[1].id);
  const starter = STARTERS.find((s) => s.id === pick)!;
  const go = () => name.trim() && onCreate(name.trim(), starter);
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>New song</h1>
          <p>Name it and pick a vibe. Everything is set up for you, and you can change any of it later.</p>
        </div>
      </div>
      <input className="field big" autoFocus placeholder="Song name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      <div className="vibe-head">
        <Label>Pick a vibe</Label>
        <span className="vibe-scale">
          slow <i /> fast
        </span>
      </div>
      <div className="vibes">
        {STARTERS.map((s) => {
          const chords = (s.text.match(/^\[.+\]\s*\n(.+)$/m)?.[1] ?? "").trim().split(/\s+/).slice(0, 4);
          return (
            <button key={s.id} className={`vibe ${pick === s.id ? "on" : ""}`} style={{ ["--flame" as string]: flame(s.bpm) }} onClick={() => setPick(s.id)} onDoubleClick={go}>
              <div className="card-glow" />
              <span className="vibe-bpm">{s.bpm} bpm</span>
              <b>{s.name}</b>
              <span className="vibe-feels">{s.feels}</span>
              <div className="card-chords">
                {chords.map((c, i) => (
                  <span key={i}>{c}</span>
                ))}
              </div>
              <span className="vibe-inst">{INSTRUMENTS.find((i) => i.id === s.instrument)?.label}</span>
            </button>
          );
        })}
      </div>
      <div className="create-actions">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary big" disabled={!name.trim()} onClick={go}>
          Create song
        </button>
      </div>
    </section>
  );
}

function SettingsPage({ sync, onRun, onReset }: { sync: number | null; onRun: () => void; onReset: () => void }) {
  return (
    <section className="page narrow">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Set once per device.</p>
        </div>
      </div>
      <div className="panel">
        <Label>Recording sync</Label>
        <div className="sync-row">
          <div>
            <b>{sync === null ? "Not synced yet" : `${Math.round(sync * 1000)} ms`}</b>
            <span>
              {sync === null
                ? "Your takes use the browser’s guess, which is usually a little late."
                : "Every take is shifted by this much so it lands exactly on the beat."}
            </span>
          </div>
          <button className="primary" onClick={onRun}>
            {sync === null ? "Run sync test" : "Run again"}
          </button>
        </div>
        <p className="hint">Run it again whenever you switch headphones or mics. Bluetooth headphones add a lot of delay; wired is best.</p>
        {sync !== null && (
          <button className="ghost" style={{ marginTop: 12 }} onClick={onReset}>
            Forget sync
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- pieces

function SyncBadge({ sync, onRun }: { sync: number | null; onRun: () => void }) {
  return (
    <div className={`sync-badge ${sync === null ? "warn" : ""}`}>
      <i />
      {sync === null ? (
        <span>
          Timing not synced. <button onClick={onRun}>Run the 10-second sync test</button> so takes land on the beat.
        </span>
      ) : (
        <span>
          Synced · {Math.round(sync * 1000)} ms <button onClick={onRun}>Re-test</button>
        </span>
      )}
    </div>
  );
}

function SyncModal({ s, onRun, onClose }: { s: SyncState; onRun: () => void; onClose: (thenRecord?: number) => void }) {
  return (
    <div
      className="dlg-backdrop"
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onKeyDown={(e) => e.key === "Escape" && s.phase !== "running" && onClose()}
      onMouseDown={(e) => e.target === e.currentTarget && s.phase !== "running" && onClose()}
    >
      <div className="dlg pop sync-dlg" role="dialog" aria-modal="true">
        {s.phase === "intro" && (
          <>
            <h3>Sync your timing</h3>
            <p>Every setup has a small delay between hearing the music and the mic catching your voice. This 10-second test measures yours so takes land exactly on the beat.</p>
            <ol className="sync-steps">
              <li>Put on the headphones you’ll sing with.</li>
              <li>You’ll hear 8 clicks. Clap (or say “ta”) right on each one.</li>
            </ol>
            <div className="dlg-actions">
              <button className="ghost" onClick={() => onClose(s.thenRecord)}>
                {s.thenRecord !== undefined ? "Skip, just record" : "Not now"}
              </button>
              <button className="primary" onClick={onRun}>
                Start test
              </button>
            </div>
          </>
        )}
        {s.phase === "running" && (
          <>
            <h3>Clap on every click</h3>
            <div className="sync-dots">
              {Array.from({ length: SYNC_CLICKS }, (_, i) => (
                <span key={i} className={i <= s.click ? "on" : ""} />
              ))}
            </div>
            <p className="center">{s.click < 0 ? "Get ready…" : `${s.click + 1} / ${SYNC_CLICKS}`}</p>
          </>
        )}
        {s.phase === "done" && (
          <>
            <h3>Synced ✓</h3>
            <p>
              Your setup’s delay is <b>{Math.round((s.result ?? 0) * 1000)} ms</b>. New takes, and the ones you already have, are lined up with it.
            </p>
            <div className="dlg-actions">
              <button className="primary" onClick={() => onClose(s.thenRecord)}>
                {s.thenRecord !== undefined ? "Start recording" : "Done"}
              </button>
            </div>
          </>
        )}
        {s.phase === "fail" && (
          <>
            <h3>Couldn’t hear the claps</h3>
            <p>Clap a bit louder, closer to the mic, right on each click.</p>
            <div className="dlg-actions">
              <button className="ghost" onClick={() => onClose(s.thenRecord)}>
                {s.thenRecord !== undefined ? "Skip, just record" : "Close"}
              </button>
              <button className="primary" onClick={onRun}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const SHAPE: { key: "warmth" | "clarity" | "air" | "edge" | "reverb" | "echo"; label: string; hint: string; bipolar?: boolean }[] = [
  { key: "warmth", label: "Warmth", hint: "body", bipolar: true },
  { key: "clarity", label: "Clarity", hint: "words cut through", bipolar: true },
  { key: "air", label: "Air", hint: "breathy sparkle", bipolar: true },
  { key: "edge", label: "Edge", hint: "grit" },
  { key: "reverb", label: "Reverb", hint: "room" },
  { key: "echo", label: "Echo", hint: "on the beat" },
];

function VoicePanel({ take, voice, tuning, onVoice, onNudge }: { take: Take; voice: Voice; tuning: boolean; onVoice: (v: Voice) => void; onNudge: (ms: number) => void }) {
  const pure = voice.preset === "pure";
  return (
    <div className="voice">
      <Label>Voice · {take.name}</Label>
      <div className="presets-grid">
        {VOICE_PRESETS.map((p) => (
          <button key={p.id} className={voice.preset === p.id ? "on" : ""} onClick={() => onVoice(voiceFromPreset(p.id, voice.tune))}>
            <b>{p.label}</b>
            <span>{p.hint}</span>
          </button>
        ))}
      </div>

      <div className={`tune-row ${voice.tune > 0 ? "on" : ""}`}>
        <button className={`sw ${voice.tune > 0 ? "on" : ""}`} onClick={() => onVoice({ ...voice, tune: voice.tune > 0 ? 0 : 0.8 })} aria-label="Toggle auto-tune" />
        <div>
          <b>Auto-tune</b>
          <span>{tuning ? "Tuning…" : "Pulls notes into the song’s key"}</span>
        </div>
      </div>
      {voice.tune > 0 && <Fader label="Tune strength" value={voice.tune} onChange={(v) => onVoice({ ...voice, tune: Math.max(0.05, Math.round(v * 20) / 20) })} />}

      {!pure && (
        <details className="shape">
          <summary>Fine-tune the sound</summary>
          <div className="mixer">
            {SHAPE.map((s) => (
              <Fader
                key={s.key}
                label={`${s.label} · ${s.hint}`}
                value={s.bipolar ? (voice[s.key] + 1) / 2 : voice[s.key]}
                onChange={(v) => onVoice({ ...voice, [s.key]: s.bipolar ? v * 2 - 1 : v })}
              />
            ))}
          </div>
        </details>
      )}

      <Label>Timing nudge</Label>
      <Stepper label="This take" value={take.nudgeMs ?? 0} unit="ms" step={5} signed onChange={(v) => onNudge(Math.max(-250, Math.min(250, v)))} />
      <p className="hint">Only if this take still feels early or late after syncing. + moves it earlier.</p>
    </div>
  );
}

function Strip(props: {
  blocks: ReturnType<typeof layout>["blocks"];
  totalBeats: number;
  totalSec: number;
  beat: number;
  bpm: number;
  loopBlock: number | null;
  takeSpan: [number, number] | null;
  onSeek: (b: number) => void;
  onLoop: (i: number) => void;
}) {
  const { blocks, totalBeats, beat, bpm, loopBlock, takeSpan, totalSec } = props;
  const ref = useRef<HTMLDivElement>(null);
  const scrub = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const b = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * totalBeats;
    const c = blocks.flatMap((bl) => bl.chords).find((ch) => b >= ch.startBeat && b < ch.startBeat + ch.beats);
    props.onSeek(c ? c.startBeat : 0);
  };
  return (
    <div className="strip-wrap">
      <div className="strip" ref={ref} onClick={scrub}>
        {blocks.map((b) => (
          <div
            key={b.index}
            className={`blk ${loopBlock === b.index ? "looped" : ""} ${beat >= b.startBeat && beat < b.startBeat + b.beats ? "cur" : ""}`}
            style={{ flexGrow: b.beats, ["--tint" as string]: TINTS[b.sectionIndex % TINTS.length] }}
            title={`${b.name} · ${fmtTime(beatsToSeconds(b.startBeat, bpm))}`}
          >
            <span className="blk-name">{b.name}</span>
            <span className="blk-time">{fmtTime(beatsToSeconds(b.startBeat, bpm))}</span>
            <button
              className="loop"
              onClick={(e) => {
                e.stopPropagation();
                props.onLoop(b.index);
              }}
              title="Loop this section"
            >
              ⟲
            </button>
          </div>
        ))}
        {takeSpan && totalSec > 0 && (
          <div
            className="take-lane"
            style={{
              left: `${(Math.max(0, takeSpan[0]) / totalSec) * 100}%`,
              width: `${((Math.min(totalSec, takeSpan[1]) - Math.max(0, takeSpan[0])) / totalSec) * 100}%`,
            }}
          />
        )}
        <div className="head" style={{ left: `${totalBeats ? (beat / totalBeats) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  );
}
