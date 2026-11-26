// Audio engine: turns the laid-out chord timeline into notes, eighth-note by eighth-note.
// The same note generator drives live playback (lookahead scheduler) and WAV export (offline render).
import { ElectricPiano, renderOffline, Scheduler, Soundfont, SplendidGrandPiano, type NoteEvent } from "smplr";

/**
 * smplr normally holds future notes in a queue drained by a 50 ms page timer. Browsers throttle page
 * timers in background tabs (Safari to ~1 s) and offline renders outrun them, so notes arrived late or
 * never. An "eager" scheduler with an effectively infinite lookahead hands every note to the audio
 * clock the moment we schedule it, which is immune to both.
 */
const eager = (ctx: BaseAudioContext) => Scheduler(ctx, { lookaheadMs: 1e9, intervalMs: 1000 });
type Sched = ReturnType<typeof eager>;
import { buildMaster, buildVocalChain, DEFAULT_MIX, DEFAULT_VOICE, impulse, type MasterChain, type MixSettings, type VocalChain, type VocalClip, type Voice as VocalVoice } from "./mix";
import type { Block } from "./song";
import { bassNote, fifthAbove, guitarVoicing, keysVoicing, parseChord, type ParsedChord } from "./theory";

export type Style = "ballad" | "arpeggio" | "strum" | "sustain" | "pulse";

export type Options = {
  instrument: string;
  style: Style;
  bass: boolean;
  drums: boolean;
  buildUp: boolean; // drums sit out the first section and intro/outro
  reverb: number; // 0..1
  levels: { harmony: number; bass: number; drums: number }; // 0..1
};

type Kind = "keys" | "guitar";
export type InstrumentDef = { id: string; label: string; kind: Kind; style: Style; note: string };

export const INSTRUMENTS: InstrumentDef[] = [
  { id: "piano", label: "Grand piano", kind: "keys", style: "ballad", note: "Sampled Steinway" },
  { id: "guitar", label: "Acoustic guitar", kind: "guitar", style: "strum", note: "Steel strings" },
  { id: "nylon", label: "Nylon guitar", kind: "guitar", style: "arpeggio", note: "Fingerpicked" },
  { id: "epiano", label: "Electric piano", kind: "keys", style: "pulse", note: "Rhodes-style" },
  { id: "strings", label: "Strings", kind: "keys", style: "sustain", note: "Ensemble" },
  { id: "pad", label: "Warm pad", kind: "keys", style: "sustain", note: "Ambient" },
  { id: "synth", label: "Synth", kind: "keys", style: "pulse", note: "Built-in, no download" },
];

export const STYLES: { id: Style; label: string }[] = [
  { id: "ballad", label: "Ballad" },
  { id: "arpeggio", label: "Fingerpick" },
  { id: "strum", label: "Strum" },
  { id: "sustain", label: "Sustain" },
  { id: "pulse", label: "Pulse" },
];

// ---------- voices ----------

type Voice = {
  ready: Promise<unknown>;
  play(midi: number, time: number, dur: number, vel: number): void;
  stop(): void;
};

function smplrVoice(inst: { ready: Promise<void>; start(e: NoteEvent): unknown; stop(): void }): Voice {
  return {
    ready: inst.ready,
    play: (midi, time, dur, vel) =>
      inst.start({ note: midi, time, duration: dur, velocity: Math.max(1, Math.min(127, Math.round(vel * 127))) }),
    stop: () => inst.stop(),
  };
}

function synthVoice(ctx: BaseAudioContext, dest: AudioNode): Voice {
  const live = new Set<GainNode>();
  return {
    ready: Promise.resolve(),
    play(midi, time, dur, vel) {
      const f = 440 * 2 ** ((midi - 69) / 12);
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.Q.value = 2;
      filt.frequency.setValueAtTime(300, time);
      filt.frequency.linearRampToValueAtTime(900 + vel * 2600, time + 0.04);
      filt.frequency.exponentialRampToValueAtTime(700 + vel * 900, time + 0.5);
      const g = ctx.createGain();
      const peak = 0.07 * vel;
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(peak, time + 0.015);
      g.gain.setTargetAtTime(peak * 0.6, time + 0.03, 0.25);
      g.gain.setTargetAtTime(0.0001, time + dur, 0.18);
      for (const det of [-9, 0, 9]) {
        const o = ctx.createOscillator();
        o.type = det === 0 ? "square" : "sawtooth";
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(filt);
        o.start(time);
        o.stop(time + dur + 1.2);
      }
      filt.connect(g).connect(dest);
      live.add(g);
      setTimeout(() => live.delete(g), (time + dur + 1.5) * 1000);
    },
    stop() {
      live.forEach((g) => g.disconnect());
      live.clear();
    },
  };
}

function makeHarmony(id: string, ctx: BaseAudioContext, dest: AudioNode, scheduler: Sched): Voice {
  switch (id) {
    case "piano":
      return smplrVoice(SplendidGrandPiano(ctx, { destination: dest, volume: 110, scheduler }));
    case "guitar":
      return smplrVoice(Soundfont(ctx, { instrument: "acoustic_guitar_steel", destination: dest, scheduler }));
    case "nylon":
      return smplrVoice(Soundfont(ctx, { instrument: "acoustic_guitar_nylon", destination: dest, volume: 127, extraGain: 2.5, scheduler }));
    case "epiano":
      return smplrVoice(ElectricPiano(ctx, { instrument: "CP80", destination: dest, scheduler }));
    case "strings":
      return smplrVoice(Soundfont(ctx, { instrument: "string_ensemble_1", destination: dest, volume: 90, scheduler }));
    case "pad":
      return smplrVoice(Soundfont(ctx, { instrument: "pad_2_warm", destination: dest, volume: 90, scheduler }));
    default:
      return synthVoice(ctx, dest);
  }
}

// ---------- drums (synthesized, so they also render offline with no download) ----------

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

type DrumHit = "kick" | "snare" | "hat" | "shaker";

function playDrum(ctx: BaseAudioContext, dest: AudioNode, hit: DrumHit, t: number, vel: number) {
  const env = (g: GainNode, peak: number, decay: number) => {
    g.gain.setValueAtTime(peak * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  };
  if (hit === "kick") {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    env(g, 0.9, 0.42);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.45);
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  if (hit === "snare") {
    f.type = "bandpass";
    f.frequency.value = 1900;
    f.Q.value = 0.8;
    env(g, 0.45, 0.2);
    const body = ctx.createOscillator();
    const bg = ctx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(220, t);
    body.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    env(bg, 0.35, 0.1);
    body.connect(bg).connect(dest);
    body.start(t);
    body.stop(t + 0.12);
  } else if (hit === "hat") {
    f.type = "highpass";
    f.frequency.value = 7500;
    env(g, 0.22, 0.05);
  } else {
    f.type = "bandpass";
    f.frequency.value = 5200;
    f.Q.value = 1.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * vel, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  }
  src.connect(f).connect(g).connect(dest);
  src.start(t, Math.random() * 0.5);
  src.stop(t + 0.3);
}

// ---------- mix bus ----------

type Bus = {
  harmony: GainNode;
  bass: GainNode;
  drums: GainNode;
  reverb: GainNode;
  master: GainNode;
};

function makeBus(ctx: BaseAudioContext, out: AudioNode, opts: Options): Bus {
  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  master.connect(comp).connect(out);

  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx);
  const reverb = ctx.createGain();
  reverb.connect(conv).connect(master);

  const bus = (send: number) => {
    const g = ctx.createGain();
    g.connect(master);
    const s = ctx.createGain();
    s.gain.value = send;
    g.connect(s).connect(reverb);
    return g;
  };
  const b: Bus = { harmony: bus(1), bass: bus(0.15), drums: bus(0.3), reverb, master };
  applyLevels(b, opts);
  return b;
}

function applyLevels(b: Bus, o: Options) {
  b.harmony.gain.value = o.levels.harmony;
  b.bass.gain.value = o.levels.bass;
  b.drums.gain.value = o.levels.drums * 0.8;
  b.reverb.gain.value = o.reverb * 0.9;
}

// ---------- note generation ----------

type Hit =
  | { part: "harmony"; midi: number; at: number; beats: number; vel: number; delay?: number }
  | { part: "bass"; midi: number; at: number; beats: number; vel: number }
  | { part: "drum"; hit: DrumHit; at: number; vel: number };

export type Flat = { symbol: string; startBeat: number; beats: number; block: Block }[];

export function flatten(blocks: Block[]): Flat {
  return blocks.flatMap((b) => b.chords.map((c) => ({ ...c, block: b })));
}

function chordAt(flat: Flat, beat: number) {
  let lo = 0;
  let hi = flat.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = flat[mid];
    if (beat < c.startBeat) hi = mid - 1;
    else if (beat >= c.startBeat + c.beats) lo = mid + 1;
    else return c;
  }
  return undefined;
}

const STRUM: Record<number, { dir: "D" | "U"; vel: number }> = {
  0: { dir: "D", vel: 0.78 },
  2: { dir: "D", vel: 0.6 },
  3: { dir: "U", vel: 0.42 },
  5: { dir: "U", vel: 0.48 },
  6: { dir: "D", vel: 0.6 },
  7: { dir: "U", vel: 0.42 },
};
const ARP = [0, 3, 2, 4, 1, 4, 2, 3];

/** Everything that should sound on eighth-note step `step` (beat = step / 2). */
export function stepHits(flat: Flat, step: number, opts: Options, kind: Kind): Hit[] {
  const b = step / 2;
  const c = chordAt(flat, b);
  if (!c) return [];
  const ch = parseChord(c.symbol);
  const out: Hit[] = [];
  const inBar = b % 4;
  const eighth = step % 8;
  const left = c.startBeat + c.beats - b; // beats left in this chord
  const fresh = b === c.startBeat;
  const block = c.block;

  if (ch) harmonyHits(out, ch, opts.style, kind, { inBar, eighth, left, fresh });
  if (ch && opts.bass) bassHits(out, ch, opts.style, { inBar, eighth, left, fresh, step });

  const restDrums = opts.buildUp && (block.index === 0 || /intro|outro/i.test(block.name));
  if (opts.drums && !restDrums) drumHits(out, opts.style, eighth, b === block.startBeat);
  return out;
}

type Pos = { inBar: number; eighth: number; left: number; fresh: boolean };

function harmonyHits(out: Hit[], ch: ParsedChord, style: Style, kind: Kind, p: Pos) {
  const keys = keysVoicing(ch);
  const guitar = guitarVoicing(ch);
  const shape = kind === "guitar" ? guitar : keys;
  const toBar = Math.min(4 - p.inBar, p.left);
  const chord = (notes: number[], beats: number, vel: number) =>
    notes.forEach((midi) => out.push({ part: "harmony", midi, at: 0, beats, vel }));

  switch (style) {
    case "sustain":
      if (p.fresh || p.inBar === 0) chord(shape, toBar + 0.1, 0.5);
      return;
    case "ballad": {
      const lh = bassNote(ch) + 12;
      if (p.fresh || p.inBar === 0) {
        out.push({ part: "harmony", midi: lh, at: 0, beats: toBar, vel: 0.55 });
        chord(shape, Math.min(2, toBar), 0.5);
      } else if (p.inBar === 2) {
        chord(shape, toBar, 0.36);
      } else if (p.inBar === 3.5 && p.left > 0.5 && kind === "keys") {
        out.push({ part: "harmony", midi: keys[keys.length - 1], at: 0, beats: 0.5, vel: 0.28 });
      }
      return;
    }
    case "arpeggio": {
      const pool = kind === "guitar" ? guitar : [bassNote(ch) + 12, ...keys];
      const idx = ARP[p.eighth] % pool.length;
      const note = p.fresh ? pool[0] : pool[idx];
      out.push({ part: "harmony", midi: note, at: 0, beats: Math.min(2, p.left + 0.25), vel: p.fresh ? 0.62 : 0.44 });
      return;
    }
    case "strum": {
      const s = STRUM[p.eighth] ?? (p.fresh ? { dir: "D" as const, vel: 0.7 } : undefined);
      if (!s) return;
      const notes = s.dir === "D" ? guitar : guitar.slice(-4).reverse();
      const spread = s.dir === "D" ? 0.014 : 0.01;
      notes.forEach((midi, i) =>
        out.push({ part: "harmony", midi, at: 0, beats: Math.min(1.5, p.left), vel: s.vel * (1 - i * 0.03), delay: i * spread }),
      );
      return;
    }
    case "pulse": {
      const accent = p.eighth % 2 === 0;
      chord(shape, 0.42, accent ? 0.5 : 0.34);
      return;
    }
  }
}

function bassHits(out: Hit[], ch: ParsedChord, style: Style, p: Pos & { step: number }) {
  const root = bassNote(ch);
  if (style === "pulse") {
    out.push({ part: "bass", midi: root, at: 0, beats: 0.45, vel: p.eighth % 2 === 0 ? 0.7 : 0.5 });
    return;
  }
  if (p.fresh || p.inBar === 0) out.push({ part: "bass", midi: root, at: 0, beats: Math.min(1.75, p.left), vel: 0.72 });
  else if (p.inBar === 2) {
    const n = style === "strum" ? fifthAbove(ch) : root;
    out.push({ part: "bass", midi: n, at: 0, beats: Math.min(1.5, p.left), vel: 0.58 });
  } else if (p.inBar === 3.5 && style === "strum" && p.left > 0.5) {
    out.push({ part: "bass", midi: root, at: 0, beats: 0.4, vel: 0.45 });
  }
}

function drumHits(out: Hit[], style: Style, eighth: number, sectionStart: boolean) {
  const pop = style === "strum" || style === "pulse";
  const kicks = pop ? [0, 3, 4] : [0, 5];
  if (kicks.includes(eighth)) out.push({ part: "drum", hit: "kick", at: 0, vel: eighth === 0 ? 1 : 0.75 });
  if (eighth === 2 || eighth === 6) out.push({ part: "drum", hit: "snare", at: 0, vel: pop ? 0.85 : 0.55 });
  if (style === "ballad" || style === "arpeggio" || style === "sustain")
    out.push({ part: "drum", hit: "shaker", at: 0, vel: eighth % 2 ? 0.55 : 0.85 });
  else out.push({ part: "drum", hit: "hat", at: 0, vel: eighth % 2 ? 0.6 : 1 });
  if (sectionStart && eighth === 0) out.push({ part: "drum", hit: "kick", at: 0, vel: 1 });
}

function emit(
  ctx: BaseAudioContext,
  hits: Hit[],
  time: number,
  secPerBeat: number,
  harmony: Voice,
  bass: Voice | null,
  drums: AudioNode,
) {
  for (const h of hits) {
    const swingless = time + h.at * secPerBeat;
    if (h.part === "harmony") harmony.play(h.midi, swingless + (h.delay ?? 0), h.beats * secPerBeat, h.vel);
    else if (h.part === "bass") bass?.play(h.midi, swingless, h.beats * secPerBeat, h.vel);
    else playDrum(ctx, drums, h.hit, swingless, h.vel);
  }
}

// ---------- live player ----------

// How far ahead notes are committed to the audio clock. Short while you're watching (instant reaction to
// edits), long while the tab is in the background (survives the browser throttling our timer to ~1 s).
const LOOKAHEAD_VISIBLE = 0.15;
const LOOKAHEAD_HIDDEN = 2.5;
const TICK_MS = 25;

/** A ticking clock in a Worker: worker timers keep firing when the page is in the background. */
function workerClock(onTick: () => void): { start(): void; stop(): void } {
  try {
    const src = `let id=null;onmessage=e=>{if(e.data==="start"&&id===null)id=setInterval(()=>postMessage(0),${TICK_MS});if(e.data==="stop"){clearInterval(id);id=null}}`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
    w.onmessage = onTick;
    return { start: () => w.postMessage("start"), stop: () => w.postMessage("stop") };
  } catch {
    let id: number | null = null;
    return {
      start: () => {
        id ??= window.setInterval(onTick, TICK_MS);
      },
      stop: () => {
        if (id !== null) clearInterval(id);
        id = null;
      },
    };
  }
}

export class Player {
  ctx = new AudioContext({ latencyHint: "interactive" });
  private opts: Options;
  private bus: Bus;
  private instGain: GainNode;
  private master: MasterChain;
  private vocalChain: VocalChain;
  private vocal: VocalClip | null = null;
  private voice: VocalVoice = DEFAULT_VOICE;
  private mix: MixSettings = DEFAULT_MIX;
  private vocalSrc: AudioBufferSourceNode | null = null;
  private vocalBuf: AudioBuffer | null = null;
  private voices = new Map<string, Voice>();
  private bass: Voice;
  private flat: Flat = [];
  private totalBeats = 0;
  private bpm = 90;
  private loop: { start: number; end: number } | null = null;

  private sched: Sched;
  private clock = workerClock(() => this.tick());
  private ticking = false;
  private drumGate: GainNode;
  private nextStep = 0;
  private nextTime = 0;
  private queue: { time: number; beat: number }[] = [];
  private pausedBeat = 0;
  private endAt: number | null = null;
  playing = false;
  onEnd: () => void = () => {};

  constructor(opts: Options) {
    this.opts = opts;
    this.master = buildMaster(this.ctx, this.ctx.destination);
    this.instGain = this.ctx.createGain();
    this.instGain.connect(this.master.input);
    this.vocalChain = buildVocalChain(this.ctx, this.master.input);
    this.bus = makeBus(this.ctx, this.instGain, opts);
    this.sched = eager(this.ctx);
    this.drumGate = this.ctx.createGain();
    this.drumGate.connect(this.bus.drums);
    this.bass = smplrVoice(
      Soundfont(this.ctx, { instrument: "electric_bass_finger", destination: this.bus.bass, volume: 105, scheduler: this.sched }),
    );
    // When the tab hides, top the queue up straight away instead of waiting for the next tick.
    document.addEventListener("visibilitychange", () => this.playing && this.tick());
    this.setMix(DEFAULT_MIX);
  }

  /** Load (or reuse) an instrument. Resolves when it can play. */
  async load(id: string) {
    let v = this.voices.get(id);
    if (!v) {
      v = makeHarmony(id, this.ctx, this.bus.harmony, this.sched);
      this.voices.set(id, v);
    }
    await v.ready;
  }

  setOptions(opts: Options) {
    if (opts.instrument !== this.opts.instrument) this.voices.get(this.opts.instrument)?.stop();
    this.opts = opts;
    applyLevels(this.bus, opts);
  }

  setMix(m: MixSettings) {
    this.mix = m;
    this.instGain.gain.value = m.inst;
    this.master.set(m.master);
    this.vocalChain.set(this.voice, m.vocal, this.bpm);
  }

  setVoice(v: VocalVoice) {
    this.voice = v;
    this.vocalChain.set(v, this.mix.vocal, this.bpm);
  }

  /** The take that plays along with the band (null = none). */
  setVocal(v: VocalClip | null) {
    this.vocal = v;
    this.vocalBuf = null;
    if (v) {
      this.vocalBuf = this.ctx.createBuffer(1, v.data.length, v.sampleRate);
      this.vocalBuf.copyToChannel(v.data as Float32Array<ArrayBuffer>, 0);
    }
    if (this.playing) this.syncVocal(this.getBeat(), this.ctx.currentTime + 0.03);
  }

  setSong(blocks: Block[], totalBeats: number) {
    this.flat = flatten(blocks);
    this.totalBeats = totalBeats;
    if (!this.playing) this.pausedBeat = Math.min(this.pausedBeat, totalBeats);
  }

  setBpm(bpm: number) {
    this.vocalChain.set(this.voice, this.mix.vocal, bpm);
    if (this.playing) {
      const beat = this.getBeat();
      this.bpm = bpm;
      this.rebase(beat);
    } else this.bpm = bpm;
  }

  setLoop(loop: { start: number; end: number } | null) {
    this.loop = loop && loop.end > loop.start ? loop : null;
  }

  getBeat(): number {
    if (!this.playing) return this.pausedBeat;
    const now = this.ctx.currentTime;
    let last: { time: number; beat: number } | undefined;
    for (const q of this.queue) {
      if (q.time <= now) last = q;
      else break;
    }
    if (!last) return this.queue[0]?.beat ?? this.pausedBeat;
    return last.beat + Math.min(0.5, ((now - last.time) * this.bpm) / 60);
  }

  /** Starts playback; resolves with the AudioContext time at which `beat` sounds. */
  async play(fromBeat = this.pausedBeat): Promise<{ time: number; beat: number }> {
    await this.ctx.resume();
    await this.load(this.opts.instrument);
    if (fromBeat >= this.totalBeats) fromBeat = 0;
    this.playing = true;
    this.endAt = null;
    const anchor = this.rebase(fromBeat);
    if (!this.ticking) {
      this.clock.start();
      this.ticking = true;
    }
    this.tick();
    return anchor;
  }

  pause() {
    this.pausedBeat = this.getBeat();
    this.halt();
  }

  stop() {
    this.pausedBeat = 0;
    this.halt();
  }

  seek(beat: number) {
    if (this.playing) {
      this.silence();
      this.rebase(beat);
    } else this.pausedBeat = beat;
  }

  private rebase(beat: number) {
    const step = Math.floor(beat * 2 + 1e-6);
    this.nextStep = step;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.queue = [];
    this.syncVocal(step / 2, this.nextTime);
    return { time: this.nextTime, beat: step / 2 };
  }

  private syncVocal(beat: number, at: number) {
    this.vocalSrc?.stop();
    this.vocalSrc = null;
    if (!this.vocal || !this.vocalBuf || !this.playing) return;
    const into = (beat * 60) / this.bpm - this.vocal.offset; // seconds into the take
    if (into >= this.vocalBuf.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.vocalBuf;
    src.connect(this.vocalChain.input);
    if (into >= 0) src.start(at, into);
    else src.start(at - into);
    this.vocalSrc = src;
  }

  private silence() {
    this.voices.forEach((v) => v.stop());
    this.bass.stop();
    // Drums are raw Web Audio nodes already queued on the clock; cut them by swapping the gate they feed.
    this.drumGate.disconnect();
    this.drumGate = this.ctx.createGain();
    this.drumGate.connect(this.bus.drums);
    this.vocalSrc?.stop();
    this.vocalSrc = null;
  }

  private halt() {
    this.playing = false;
    this.clock.stop();
    this.ticking = false;
    this.queue = [];
    this.silence();
  }

  private tick() {
    const now = this.ctx.currentTime;
    const voice = this.voices.get(this.opts.instrument);
    const kind = INSTRUMENTS.find((i) => i.id === this.opts.instrument)?.kind ?? "keys";
    const ahead = document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD_VISIBLE;
    let guard = 0;
    while (this.endAt === null && this.nextTime < now + ahead && guard++ < 512) {
      let beat = this.nextStep / 2;
      if (this.loop && beat >= this.loop.end) {
        this.nextStep = Math.floor(this.loop.start * 2);
        beat = this.nextStep / 2;
        this.syncVocal(beat, this.nextTime);
      }
      if (beat >= this.totalBeats) {
        this.endAt = this.nextTime;
        break;
      }
      const spb = 60 / this.bpm;
      // A step whose moment already passed (tab was frozen) is skipped, not crammed in late as a burst.
      if (voice && this.nextTime >= now - 0.01)
        emit(this.ctx, stepHits(this.flat, this.nextStep, this.opts, kind), this.nextTime, spb, voice, this.bass, this.drumGate);
      this.queue.push({ time: this.nextTime, beat });
      if (this.queue.length > 64) this.queue.shift();
      this.nextTime += spb / 2;
      this.nextStep++;
    }
    if (this.endAt !== null && now > this.endAt + 0.05) {
      this.pausedBeat = 0;
      this.halt();
      this.onEnd();
    }
  }
}

// ---------- instrumental render (cached) ----------

const SR = 44100;
const renderCache = new Map<string, Promise<AudioBuffer>>();

export function instrumentalKey(blocks: Block[], bpm: number, opts: Options) {
  const chords = blocks.map((b) => [b.index === 0 || /intro|outro/i.test(b.name), b.chords.map((c) => c.symbol + ":" + c.beats).join(",")]);
  return JSON.stringify([2, chords, bpm, opts]);
}

/**
 * Renders the band (no vocal) offline. Memoised by content, so the background pre-render
 * makes "Export" instant, and the mix/pack exports reuse the same buffer.
 */
export function renderInstrumental(blocks: Block[], totalBeats: number, bpm: number, opts: Options): Promise<AudioBuffer> {
  const key = instrumentalKey(blocks, bpm, opts);
  const hit = renderCache.get(key);
  if (hit) return hit;
  if (renderCache.size > 4) renderCache.delete(renderCache.keys().next().value!);
  const spb = 60 / bpm;
  const kind = INSTRUMENTS.find((i) => i.id === opts.instrument)?.kind ?? "keys";
  const flat = flatten(blocks);
  const job = renderOffline(
    async (ctx) => {
      const bus = makeBus(ctx, ctx.destination, opts);
      const sched = eager(ctx);
      const harmony = makeHarmony(opts.instrument, ctx, bus.harmony, sched);
      const bass = opts.bass
        ? smplrVoice(Soundfont(ctx, { instrument: "electric_bass_finger", destination: bus.bass, volume: 105, scheduler: sched }))
        : null;
      await Promise.all([harmony.ready, bass?.ready]);
      // Song timeline starts at exactly 0 so stems line up sample-accurately in a DAW.
      for (let s = 0; s < totalBeats * 2; s++) emit(ctx, stepHits(flat, s, opts, kind), (s / 2) * spb, spb, harmony, bass, bus.drums);
    },
    { duration: totalBeats * spb + 3, sampleRate: SR },
  ).then((r) => r.audioBuffer);
  job.catch(() => renderCache.delete(key));
  renderCache.set(key, job);
  return job;
}

export function isRendered(blocks: Block[], bpm: number, opts: Options) {
  return renderCache.has(instrumentalKey(blocks, bpm, opts));
}
