import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INSTRUMENTS, instrumentalKey, isRendered, Player, renderInstrumental, STYLES, type Options, type Style } from "./engine";
import { DEFAULT_MIX, download, renderMix, renderVocalStem, wav16, zip, type MixSettings, type VocalClip, type VocalMode } from "./mix";
import {
  BEATS_PER_BAR,
  beatsToSeconds,
  fmtTime,
  isValidChord,
  layout,
  parseChordMap,
  PRESETS,
  serializeSong,
  type Song,
} from "./song";
import { deleteTake, getTakes, loadProjects, putTake, saveProjects, uid, type Project, type Take } from "./store";
import { transposeSong } from "./theory";
import { askConfirm, askText, askTextAndChoice, DialogHost, notify } from "./dialog";
import { ChordInput, Chips, Fader, Label, PauseIcon, PlayIcon, StartIcon, Stepper, StopIcon } from "./ui";
import { autotune, detectScale, MicRecorder } from "./vocal";

const DEFAULT_OPTS: Options = {
  instrument: "piano",
  style: "ballad",
  bass: true,
  drums: true,
  buildUp: true,
  reverb: 0.35,
  levels: { harmony: 0.9, bass: 0.7, drums: 0.55 },
};

const MODES: { id: VocalMode; label: string }[] = [
  { id: "pure", label: "Pure" },
  { id: "natural", label: "Natural" },
  { id: "tuned", label: "Auto-tune" },
];

// Warm, low-chroma section tints so the strip reads as one palette with the sun-yellow accent.
const TINTS = ["#FFC21A", "#F5A524", "#E8D7A8", "#C98A3B", "#FFE58A", "#B8A27A", "#F0B75E", "#D9C38F"];

function newProject(name: string, text: string): Project {
  return {
    id: uid(),
    name,
    text: text.replace(/^title:.*$/m, `title: ${name}`),
    transpose: 0,
    opts: DEFAULT_OPTS,
    mix: DEFAULT_MIX,
    selectedTake: null,
    updatedAt: Date.now(),
  };
}

const boot = (() => {
  const s = loadProjects();
  if (s.projects.length && s.projects.some((p) => p.id === s.currentId)) return s;
  if (s.projects.length) return { projects: s.projects, currentId: s.projects[0].id };
  const p = newProject("Aaina", PRESETS[0].text);
  return { projects: [p], currentId: p.id };
})();
const bootProject = boot.projects.find((p) => p.id === boot.currentId)!;
const bootParse = parseChordMap(bootProject.text);

const safe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim() || "song";

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

  // ---------- transport ----------
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [beat, setBeat] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  const [loopBlock, setLoopBlock] = useState<number | null>(null);
  const [view, setView] = useState<"compose" | "record" | "mix">("compose");
  const [sideTab, setSideTab] = useState<"sound" | "map">("sound");
  const [busy, setBusy] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);

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
        const next = ps.map((p) =>
          p.id === currentId ? { ...p, text, opts, transpose, mix, selectedTake, updatedAt: Date.now() } : p,
        );
        saveProjects(next, currentId);
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [currentId, text, opts, transpose, mix, selectedTake]);

  // load takes for the open project
  useEffect(() => {
    let live = true;
    getTakes(currentId).then((t) => live && setTakes(t));
    return () => {
      live = false;
    };
  }, [currentId]);

  // first instrument preload
  useEffect(() => {
    setLoading(bootProject.opts.instrument);
    player.load(bootProject.opts.instrument).finally(() => setLoading(null));
  }, [player]);

  // ---------- the take that sings along ----------
  const tunedCache = useRef(new Map<string, Float32Array>());
  const activeTake = pending ?? takes.find((t) => t.id === selectedTake) ?? null;

  const clipFor = useCallback(
    (take: Take, m: MixSettings): VocalClip => {
      let data = take.data;
      if (m.mode === "tuned") {
        const key = `${take.id}|${scale.join(",")}|${m.tune}`;
        let d = tunedCache.current.get(key);
        if (!d) {
          d = autotune(take.data, take.sampleRate, scale, m.tune);
          tunedCache.current.set(key, d);
        }
        data = d;
      }
      return { data, sampleRate: take.sampleRate, offset: take.offset - m.latencyMs / 1000 };
    },
    [scale],
  );

  useEffect(() => {
    if (recording || !activeTake) {
      player.setVocal(null);
      return;
    }
    let cancelled = false;
    const needsTune = mix.mode === "tuned";
    if (needsTune) setTuning(true);
    // let the "tuning…" label paint before the CPU-heavy pass
    const t = setTimeout(() => {
      if (cancelled) return;
      player.setVocal(clipFor(activeTake, mix));
      setTuning(false);
    }, needsTune ? 30 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, activeTake, recording, mix.mode, mix.tune, mix.latencyMs, clipFor]);

  // ---------- background pre-render so export is instant ----------
  const instKey = instrumentalKey(blocks, song.bpm, opts);
  useEffect(() => {
    if (playing || recording || isRendered(blocks, song.bpm, opts)) {
      if (isRendered(blocks, song.bpm, opts)) renderInstrumental(blocks, totalBeats, song.bpm, opts).then(() => setRenderedKey(instKey));
      return;
    }
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
    let offset = beatsToSeconds(meta.beat, meta.bpm) + (r.t0 - meta.time) - recorder.roundTripLatency();
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
    // keep the big chord in view while singing
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

  // ---------- transport actions ----------
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
      if (["TEXTAREA", "INPUT", "SELECT"].includes(t.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // ---------- takes ----------
  const keepTake = async () => {
    if (!pending) return;
    await putTake(pending);
    setTakes((t) => [...t, pending]);
    setSelectedTake(pending.id);
    setPending(null);
  };

  const renameTake = (id: string, name: string) => {
    setTakes((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, name };
        putTake(next);
        return next;
      }),
    );
  };

  const removeTake = async (t: Take) => {
    if (!(await askConfirm(`Delete “${t.name}”?`, "This take will be gone for good. Download it first if you might want it later."))) return;
    await deleteTake(t.id);
    setTakes((ts) => ts.filter((x) => x.id !== t.id));
    if (selectedTake === t.id) setSelectedTake(null);
  };

  const listenTo = async (t: Take) => {
    setSelectedTake(t.id);
    const songBeat = (t.offset * song.bpm) / 60;
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
      const m = dry ? { ...mix, mode: "pure" as const, vocal: 1 } : mix;
      const buf = await renderVocalStem(clipFor(t, m), m, totalSec + 3);
      download(wav16(buf), `${base} - vocal ${dry ? "dry" : "fx"} - ${safe(t.name)}.wav`);
    });

  const exportMix = () =>
    withBusy("Mixing…", async () => {
      const buf = await renderMix(await instBuffer(), activeTake ? clipFor(activeTake, mix) : null, mix);
      download(wav16(buf), `${base} - mix${activeTake ? " - " + safe(activeTake.name) : ""}.wav`);
    });

  const exportPack = () =>
    withBusy("Building pack…", async () => {
      const inst = await instBuffer();
      const files: Record<string, Uint8Array> = { [`${base}/instrumental.wav`]: wav16(inst) };
      if (activeTake) {
        files[`${base}/vocal fx - ${safe(activeTake.name)}.wav`] = wav16(await renderVocalStem(clipFor(activeTake, mix), mix, totalSec + 3));
        files[`${base}/mix - ${safe(activeTake.name)}.wav`] = wav16(await renderMix(inst, clipFor(activeTake, mix), mix));
      }
      const dry = { ...mix, mode: "pure" as const, vocal: 1 };
      for (const t of takes) files[`${base}/takes (dry)/${safe(t.name)}.wav`] = wav16(await renderVocalStem(clipFor(t, dry), dry, totalSec + 3));
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
    const t = await file.text();
    applyText(t);
    setSideTab("map");
  };

  const editChord = (si: number, fn: (s: Song) => void) => {
    const next = structuredClone(song);
    fn(next);
    commitSong(next);
    void si;
  };

  // ---------- projects ----------
  const openProject = (id: string, list = projects) => {
    const p = list.find((x) => x.id === id);
    if (!p || id === currentId) return setMenu(false);
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
    setMix(p.mix);
    setSelectedTake(p.selectedTake);
    setPending(null);
    setLoopBlock(null);
    setTakes([]);
    setMenu(false);
    player.load(p.opts.instrument);
  };

  const createProject = async () => {
    setMenu(false);
    const r = await askTextAndChoice(
      "New song",
      "",
      PRESETS.map((p, i) => ({ id: String(i), label: p.name, hint: `${p.text.match(/^tempo:\s*(\d+)/m)?.[1] ?? "90"} bpm` })),
    );
    if (!r) return;
    const p = newProject(r.name, PRESETS[Number(r.choice)].text);
    const next = [...projects, p];
    setProjects(next);
    saveProjects(next, currentId);
    openProject(p.id, next);
  };

  const renameProject = async () => {
    setMenu(false);
    const name = await askText("Rename song", project.name, { confirm: "Rename" });
    if (!name || name === project.name) return;
    setProjects((ps) => {
      const next = ps.map((p) => (p.id === currentId ? { ...p, name } : p));
      saveProjects(next, currentId);
      return next;
    });
    const t = text.replace(/^title:.*$/m, `title: ${name}`);
    applyText(/^title:/m.test(t) ? t : `title: ${name}\n${t}`);
  };

  const removeProject = async () => {
    setMenu(false);
    if (projects.length <= 1) return;
    const ok = await askConfirm(
      `Delete “${project.name}”?`,
      `Its chords, settings and ${takes.length} take${takes.length === 1 ? "" : "s"} will be deleted from this browser. Export a pack first if you want to keep anything.`,
      "Delete song",
    );
    if (!ok) return;
    const gone = project.id;
    await Promise.all(takes.map((t) => deleteTake(t.id)));
    const rest = projects.filter((p) => p.id !== gone);
    openProject(rest[0].id, rest);
    setProjects(rest);
    saveProjects(rest, rest[0].id);
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

  return (
    <div className="app">
      <DialogHost />
      <header className="top">
        <div className="brand">
          <span className="dot" /> MELODICAL
        </div>
        <div className="proj">
          <button className="proj-btn" onClick={() => setMenu((m) => !m)}>
            <span className="lbl">Project</span>
            <b>{project.name}</b>
            <span className="caret">▾</span>
          </button>
          {menu && (
            <>
              <div className="scrim" onMouseDown={() => setMenu(false)} />
              <div className="proj-menu pop">
                <div className="pop-head">Your songs</div>
                <div className="proj-list">
                  {[...projects]
                    .sort((x, y) => y.updatedAt - x.updatedAt)
                    .map((p) => (
                      <button key={p.id} className={`proj-row ${p.id === currentId ? "on" : ""}`} onClick={() => openProject(p.id)}>
                        <i />
                        <b>{p.name}</b>
                        <span>{p.id === currentId ? "Open" : new Date(p.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                      </button>
                    ))}
                </div>
                <div className="pop-foot">
                  <button className="primary" onClick={createProject}>
                    + New song
                  </button>
                  <button className="ghost" onClick={renameProject}>
                    Rename
                  </button>
                  <button className="ghost danger" onClick={removeProject} disabled={projects.length <= 1} title={projects.length <= 1 ? "You need at least one song" : "Delete this song"}>
                    Delete
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="top-meta">
          <span>{fmtTime(totalSec)}</span>
          <span className="sep">/</span>
          <span>{takes.length} take{takes.length === 1 ? "" : "s"}</span>
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
            <button className="play" onClick={togglePlay} disabled={!!loading && !playing} aria-label="Play / pause" title="Play from here (space)">
              {loading && !playing ? <span className="spin" /> : playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="round" onClick={backToStart} aria-label="Stop" title="Stop and go back to the start">
              <StopIcon />
            </button>
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
                {activeTake && !recording && <> · 🎤 {activeTake.name}{tuning ? " (tuning…)" : ""}</>}
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
          takeSpan={activeTake && !recording ? [activeTake.offset, activeTake.offset + activeTake.data.length / activeTake.sampleRate] : null}
          totalSec={totalSec}
          onSeek={seek}
          onLoop={(i) => setLoopBlock((cur) => (cur === i ? null : i))}
        />
      </section>

      {pending && (
        <div className="pending">
          <div>
            <b>New take · {fmtTime(pending.data.length / pending.sampleRate)}</b>
            <span>Starts at {fmtTime(pending.offset)}. Press play to hear it with the band, then keep or toss it.</span>
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

      <nav className="views">
        {(["compose", "record", "mix"] as const).map((v) => (
          <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
            {v === "compose" ? "Compose" : v === "record" ? "Record" : "Mix & export"}
          </button>
        ))}
      </nav>

      {view === "compose" && (
        <main className="grid">
          <section className="panel sections">
            <div className="panel-head">
              <h2>Chord map</h2>
              <p>Each tile is one chord. Set how long it rings in bars ({beatsToSeconds(4, song.bpm).toFixed(1)}s per bar at {song.bpm} bpm).</p>
            </div>
            {song.sections.map((s, si) => (
              <div className="sec" key={s.name + si}>
                <div className="sec-name">
                  <i style={{ background: TINTS[si % TINTS.length] }} />
                  {s.name}
                  <span>{s.chords.reduce((a, c) => a + c.bars, 0)} bars</span>
                  <button
                    className="add"
                    onClick={() => editChord(si, (n) => n.sections[si].chords.push({ symbol: s.chords.at(-1)?.symbol ?? "C", bars: 1 }))}
                  >
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
                        <ChordInput value={c.symbol} shown={shown} onCommit={(v) => editChord(si, (n) => (n.sections[si].chords[ci].symbol = v))} />
                        <div className="dur">
                          <button onClick={() => editChord(si, (n) => (n.sections[si].chords[ci].bars = Math.max(0.5, c.bars - 0.5)))}>−</button>
                          <span>
                            {c.bars} bar{c.bars === 1 ? "" : "s"}
                            <em>{beatsToSeconds(c.bars * 4, song.bpm).toFixed(1)}s</em>
                          </span>
                          <button onClick={() => editChord(si, (n) => (n.sections[si].chords[ci].bars = Math.min(8, c.bars + 0.5)))}>+</button>
                        </div>
                        <button
                          className="x"
                          onClick={() => s.chords.length > 1 && editChord(si, (n) => n.sections[si].chords.splice(ci, 1))}
                          aria-label="Remove chord"
                        >
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

      {view === "record" && (
        <main className="grid">
          <section className="panel">
            <div className="panel-head">
              <h2>Takes</h2>
              <p>Every take you keep is saved in this browser. Pick one to hear it with the band.</p>
            </div>
            {takes.length === 0 && !pending && (
              <div className="empty">
                <b>No takes yet.</b>
                <span>Hit “Rec from start” and sing. Headphones on, so the band doesn’t leak into your mic.</span>
              </div>
            )}
            <div className="takes">
              {takes.map((t) => (
                <div key={t.id} className={`take ${selectedTake === t.id ? "on" : ""}`}>
                  <button className="pick" onClick={() => setSelectedTake(selectedTake === t.id ? null : t.id)} aria-label="Use this take" />
                  <input className="take-name" defaultValue={t.name} onBlur={(e) => e.target.value.trim() && renameTake(t.id, e.target.value.trim())} />
                  <span className="take-meta">
                    {fmtTime(t.data.length / t.sampleRate)} · from {fmtTime(t.offset)}
                    {t.bpm !== song.bpm && <em> · sung at {t.bpm} bpm</em>}
                  </span>
                  <button className="mini" onClick={() => listenTo(t)} title="Play with the band">
                    ▶
                  </button>
                  <button className="mini" onClick={() => exportVocal(t, false)} title="Download this vocal (with FX)">
                    ⤓
                  </button>
                  <button className="mini danger" onClick={() => removeTake(t)} title="Delete take">
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>

          <aside className="panel side">
            <VocalControls mix={mix} setMix={setMix} tuning={tuning} />
            <Label>Mic</Label>
            <div className="meter">
              <i style={{ width: `${Math.min(100, micLevel * 140)}%` }} />
            </div>
            <p className="hint">
              {recorder.ready ? "Mic connected." : "The mic connects when you first press record."} Turn off headphones’ noise cancelling if your voice sounds thin.
            </p>
            <Label>Timing</Label>
            <Stepper label="Vocal nudge" value={mix.latencyMs} unit="ms" step={10} signed onChange={(v) => setMix({ ...mix, latencyMs: Math.max(-300, Math.min(300, v)) })} />
            <p className="hint">If your takes sound late against the band, nudge up (moves the vocal earlier). Bluetooth headphones usually need +150 to +250 ms.</p>
          </aside>
        </main>
      )}

      {view === "mix" && (
        <main className="grid">
          <section className="panel">
            <div className="panel-head">
              <h2>Mix & master</h2>
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
            <Label>Levels</Label>
            <div className="mixer">
              <Fader label="Instrumental" value={mix.inst} max={1.2} onChange={(v) => setMix({ ...mix, inst: v })} />
              <Fader label="Vocal" value={mix.vocal} max={1.5} onChange={(v) => setMix({ ...mix, vocal: v })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={mix.master} onChange={() => setMix({ ...mix, master: !mix.master })} />
              Master bus: glue compression + limiter (louder, more finished)
            </label>

            <Label>Export</Label>
            <div className="exports">
              <button onClick={exportInstrumental} disabled={!!busy}>
                <b>Instrumental {instReady && "⚡"}</b>
                <span>Band only, WAV. Drop it into GarageBand.</span>
              </button>
              <button onClick={() => exportVocal(activeTake, false)} disabled={!!busy || !activeTake}>
                <b>Vocal · with FX</b>
                <span>Your take with reverb/tune, starts at 0:00.</span>
              </button>
              <button onClick={() => exportVocal(activeTake, true)} disabled={!!busy || !activeTake}>
                <b>Vocal · dry</b>
                <span>Raw take for mixing elsewhere, starts at 0:00.</span>
              </button>
              <button onClick={exportMix} disabled={!!busy}>
                <b>Full mix</b>
                <span>Band + vocal, mastered.</span>
              </button>
              <button className="wide" onClick={exportPack} disabled={!!busy}>
                <b>Export pack (.zip)</b>
                <span>Instrumental, vocal FX, mix, every take dry, and the chord sheet.</span>
              </button>
            </div>
            {busy && <p className="hint busy">{busy}</p>}
          </section>
          <aside className="panel side">
            <VocalControls mix={mix} setMix={setMix} tuning={tuning} />
          </aside>
        </main>
      )}
    </div>
  );
}

function VocalControls({ mix, setMix, tuning }: { mix: MixSettings; setMix: (m: MixSettings) => void; tuning: boolean }) {
  return (
    <>
      <Label>Your voice</Label>
      <Chips value={mix.mode} options={MODES} onChange={(mode) => setMix({ ...mix, mode })} />
      <p className="hint">
        {mix.mode === "pure"
          ? "Exactly what the mic heard. No EQ, no reverb."
          : mix.mode === "natural"
            ? "Cleaned up: low-cut, a little presence, gentle compression, vocal reverb."
            : "Natural, plus pitch correction to the song’s key." + (tuning ? " Tuning…" : "")}
      </p>
      <div className="mixer">
        <Fader label="Vocal reverb" value={mix.vocalReverb} enabled={mix.mode !== "pure"} onChange={(v) => setMix({ ...mix, vocalReverb: v })} />
        {mix.mode === "tuned" && <Fader label="Tune strength" value={mix.tune} onChange={(v) => setMix({ ...mix, tune: Math.round(v * 20) / 20 })} />}
      </div>
    </>
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
            style={{ left: `${(Math.max(0, takeSpan[0]) / totalSec) * 100}%`, width: `${(Math.min(totalSec, takeSpan[1]) - Math.max(0, takeSpan[0])) / totalSec * 100}%` }}
          />
        )}
        <div className="head" style={{ left: `${totalBeats ? (beat / totalBeats) * 100 : 0}%` }} />
      </div>
    </div>
  );
}
