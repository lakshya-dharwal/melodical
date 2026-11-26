import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportWav, INSTRUMENTS, Player, STYLES, type Options, type Style } from "./engine";
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
import { transposeSong } from "./theory";

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

const initial = parseChordMap(PRESETS[0].text);

export default function App() {
  const [song, setSong] = useState<Song>(initial.song);
  const [text, setText] = useState(PRESETS[0].text);
  const [warnings, setWarnings] = useState<string[]>(initial.warnings);
  const [dirty, setDirty] = useState(false);
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTS);
  const [transpose, setTranspose] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  const [loopBlock, setLoopBlock] = useState<number | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [tab, setTab] = useState<"sound" | "map">("sound");

  const playerRef = useRef<Player | null>(null);
  const player = useMemo(() => {
    if (!playerRef.current) playerRef.current = new Player(DEFAULT_OPTS);
    return playerRef.current;
  }, []);

  const played = useMemo(() => transposeSong(song, transpose), [song, transpose]);
  const { blocks, totalBeats } = useMemo(() => layout(played), [played]);
  const totalSec = beatsToSeconds(totalBeats, song.bpm);

  useEffect(() => player.setSong(blocks, totalBeats), [player, blocks, totalBeats]);
  useEffect(() => player.setBpm(song.bpm), [player, song.bpm]);
  useEffect(() => player.setOptions(opts), [player, opts]);
  useEffect(() => {
    const b = loopBlock !== null ? blocks[loopBlock] : undefined;
    player.setLoop(b ? { start: b.startBeat, end: b.startBeat + b.beats } : null);
  }, [player, blocks, loopBlock]);
  useEffect(() => {
    player.onEnd = () => {
      setPlaying(false);
      setBeat(0);
    };
  }, [player]);

  // Preload the starting instrument so the first press of play is instant.
  useEffect(() => {
    setLoading(opts.instrument);
    player.load(opts.instrument).finally(() => setLoading(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setBeat(player.getBeat());
      raf = requestAnimationFrame(loop);
    };
    if (playing) raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player, playing]);

  const togglePlay = useCallback(async () => {
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
  }, [player, opts.instrument]);

  const stop = () => {
    player.stop();
    setPlaying(false);
    setBeat(0);
  };

  const seek = (b: number) => {
    player.seek(b);
    setBeat(b);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.code === "Space" && !["TEXTAREA", "INPUT", "SELECT"].includes(t.tagName)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

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

  // Song edits from the tiles keep the text map in sync, and vice versa.
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
    setWarnings(r.warnings);
    setDirty(false);
    setLoopBlock(null);
    seek(0);
  };

  const onUpload = async (file: File) => {
    const t = await file.text();
    setText(t);
    applyText(t);
    setTab("map");
  };

  const setBars = (si: number, ci: number, bars: number) => {
    const next = structuredClone(song);
    next.sections[si].chords[ci].bars = Math.max(0.5, Math.min(8, bars));
    commitSong(next);
  };

  const setSymbol = (si: number, ci: number, symbol: string) => {
    const next = structuredClone(song);
    next.sections[si].chords[ci].symbol = symbol;
    commitSong(next);
  };

  const addChord = (si: number) => {
    const next = structuredClone(song);
    const last = next.sections[si].chords.at(-1);
    next.sections[si].chords.push({ symbol: last?.symbol ?? "C", bars: 1 });
    commitSong(next);
  };

  const removeChord = (si: number, ci: number) => {
    const next = structuredClone(song);
    if (next.sections[si].chords.length <= 1) return;
    next.sections[si].chords.splice(ci, 1);
    commitSong(next);
  };

  const doExport = async () => {
    setExporting("Starting…");
    try {
      const blob = await exportWav(blocks, totalBeats, song.bpm, opts, setExporting);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${song.title.replace(/[^\w-]+/g, "_")}_instrumental_${opts.instrument}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      console.error(e);
      alert("Export failed: " + (e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  // Where are we?
  const block = blocks.find((b) => beat >= b.startBeat && beat < b.startBeat + b.beats) ?? blocks[0];
  const chordIdx = block ? block.chords.findIndex((c) => beat >= c.startBeat && beat < c.startBeat + c.beats) : -1;
  const chord = block?.chords[Math.max(0, chordIdx)];
  const flatAll = blocks.flatMap((b) => b.chords);
  const flatIdx = chord ? flatAll.indexOf(chord) : -1;
  const nextChord = flatAll[flatIdx + 1];
  const beatInBar = Math.floor(beat % BEATS_PER_BAR);
  const chordProgress = chord ? Math.min(1, (beat - chord.startBeat) / chord.beats) : 0;
  const instrumentDef = INSTRUMENTS.find((i) => i.id === opts.instrument)!;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="dot" /> MELODICAL
        </div>
        <div className="top-meta">
          <span>{song.title}</span>
          <span className="sep">/</span>
          <span>{fmtTime(totalSec)}</span>
        </div>
        <button className="ghost" onClick={doExport} disabled={!!exporting}>
          {exporting ?? "Export WAV"}
        </button>
      </header>

      <section className={`hero ${playing ? "is-playing" : ""}`}>
        <div className="glow" style={{ ["--pulse" as string]: playing ? (beatInBar === 0 ? 1 : 0.55) : 0.35 }}>
          <i className="g1" />
          <i className="g2" />
          <i className="g3" />
        </div>
        <div className="hero-inner">
          <div className="now">
            <div className="eyebrow">
              {block?.name ?? "—"}
              {loopBlock !== null && <span className="tag">LOOP</span>}
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
            <button className="play" onClick={togglePlay} disabled={!!loading && !playing} aria-label="Play">
              {loading && !playing ? <span className="spin" /> : playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="round" onClick={stop} aria-label="Stop">
              <StopIcon />
            </button>
            <div className="readout">
              <div className="time">
                {fmtTime(beatsToSeconds(beat, song.bpm))}
                <span> / {fmtTime(totalSec)}</span>
              </div>
              <div className="sub">
                {instrumentDef.label} · {STYLES.find((s) => s.id === opts.style)?.label}
                {loading && <em> · loading {INSTRUMENTS.find((i) => i.id === loading)?.label.toLowerCase()}…</em>}
              </div>
            </div>
            <Stepper
              label="Tempo"
              value={song.bpm}
              unit="bpm"
              onChange={(v) => commitSong({ ...song, bpm: Math.max(40, Math.min(220, v)) })}
              step={2}
            />
            <Stepper
              label="Key"
              value={transpose}
              unit="st"
              signed
              onChange={(v) => setTranspose(Math.max(-11, Math.min(11, v)))}
              step={1}
            />
          </div>
        </div>

        <Strip
          blocks={blocks}
          totalBeats={totalBeats}
          beat={beat}
          bpm={song.bpm}
          sectionNames={song.sections.map((s) => s.name)}
          loopBlock={loopBlock}
          onSeek={seek}
          onLoop={(i) => setLoopBlock((cur) => (cur === i ? null : i))}
        />
      </section>

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
                <button className="add" onClick={() => addChord(si)}>
                  + chord
                </button>
              </div>
              <div className="tiles">
                {s.chords.map((c, ci) => {
                  const active = !!block && block.sectionIndex === si && chordIdx === ci;
                  const shown = played.sections[si].chords[ci].symbol;
                  return (
                    <div
                      className={`tile ${active ? "active" : ""} ${isValidChord(c.symbol) ? "" : "bad"}`}
                      key={ci}
                      style={{ flexGrow: c.bars }}
                    >
                      {active && <div className="fill" style={{ width: `${chordProgress * 100}%` }} />}
                      <ChordInput value={c.symbol} shown={shown} onCommit={(v) => setSymbol(si, ci, v)} />
                      <div className="dur">
                        <button onClick={() => setBars(si, ci, c.bars - 0.5)}>−</button>
                        <span>
                          {c.bars} bar{c.bars === 1 ? "" : "s"}
                          <em>{beatsToSeconds(c.bars * 4, song.bpm).toFixed(1)}s</em>
                        </span>
                        <button onClick={() => setBars(si, ci, c.bars + 0.5)}>+</button>
                      </div>
                      <button className="x" onClick={() => removeChord(si, ci)} aria-label="Remove chord">
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
            <button className={tab === "sound" ? "on" : ""} onClick={() => setTab("sound")}>
              Sound
            </button>
            <button className={tab === "map" ? "on" : ""} onClick={() => setTab("map")}>
              Paste / upload
            </button>
          </div>

          {tab === "sound" ? (
            <div className="sound">
              <Label>Instrument</Label>
              <div className="inst-grid">
                {INSTRUMENTS.map((i) => (
                  <button
                    key={i.id}
                    className={`inst ${opts.instrument === i.id ? "on" : ""}`}
                    onClick={() => pickInstrument(i.id)}
                    disabled={!!loading}
                  >
                    <b>{i.label}</b>
                    <span>{loading === i.id ? "loading…" : i.note}</span>
                  </button>
                ))}
              </div>

              <Label>Feel</Label>
              <div className="chips">
                {STYLES.map((s) => (
                  <button
                    key={s.id}
                    className={opts.style === s.id ? "on" : ""}
                    onClick={() => setOpts({ ...opts, style: s.id as Style })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

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

              <div className="soon">
                <b>Coming next</b>
                <span>Record vocals over the track · lyrics under each chord · hum → chords</span>
              </div>
            </div>
          ) : (
            <div className="map">
              <div className="presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => {
                      setText(p.text);
                      applyText(p.text);
                    }}
                  >
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
    </div>
  );
}

function Strip(props: {
  blocks: ReturnType<typeof layout>["blocks"];
  totalBeats: number;
  beat: number;
  bpm: number;
  sectionNames: string[];
  loopBlock: number | null;
  onSeek: (b: number) => void;
  onLoop: (i: number) => void;
}) {
  const { blocks, totalBeats, beat, bpm, loopBlock } = props;
  const ref = useRef<HTMLDivElement>(null);
  const scrub = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const b = x * totalBeats;
    // snap to the chord under the cursor so playback starts on a downbeat
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
        <div className="head" style={{ left: `${totalBeats ? (beat / totalBeats) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function ChordInput({ value, shown, onCommit }: { value: string; shown: string; onCommit: (v: string) => void }) {
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

function Stepper(props: { label: string; value: number; unit: string; step: number; signed?: boolean; onChange: (v: number) => void }) {
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

function Fader(props: { label: string; value: number; enabled?: boolean; onToggle?: () => void; onChange: (v: number) => void }) {
  const on = props.enabled ?? true;
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
      <input type="range" min={0} max={1} step={0.01} value={props.value} disabled={!on} onChange={(e) => props.onChange(Number(e.target.value))} style={{ ["--v" as string]: `${props.value * 100}%` }} />
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => <div className="label">{children}</div>;

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="28" height="28">
    <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26">
    <rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" />
  </svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
  </svg>
);
