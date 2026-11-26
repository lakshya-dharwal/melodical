// Vocal chain, mastering chain, offline mixdowns, WAV + zip encoding.
import { zipSync } from "fflate";

/** Song-level mix: band vs vocal balance and the master bus. Per-take vocal sound lives in `Voice`. */
export type MixSettings = {
  inst: number; // instrumental level 0..1.2
  vocal: number; // vocal level 0..1.5
  master: boolean; // glue compression + limiter on the full mix
};

export const DEFAULT_MIX: MixSettings = { inst: 0.85, vocal: 1, master: true };

/** How one take sounds. Every take carries its own, so you can compare ideas. */
export type Voice = {
  preset: VoicePresetId;
  warmth: number; // -1..1  low-mid body (±6 dB @ 220 Hz)
  clarity: number; // -1..1 presence (±6 dB @ 3.5 kHz)
  air: number; // -1..1    sparkle (±6 dB shelf @ 11 kHz)
  edge: number; // 0..1    saturation grit
  reverb: number; // 0..1
  echo: number; // 0..1    dotted-eighth throw, synced to tempo
  tune: number; // 0 = off, else auto-tune strength 0..1
};

export type VoicePresetId = "pure" | "natural" | "warm" | "pop" | "edge" | "dreamy";

export const VOICE_PRESETS: { id: VoicePresetId; label: string; hint: string; voice: Omit<Voice, "preset" | "tune"> }[] = [
  { id: "pure", label: "Pure", hint: "Exactly what the mic heard", voice: { warmth: 0, clarity: 0, air: 0, edge: 0, reverb: 0, echo: 0 } },
  { id: "natural", label: "Natural", hint: "Clean, polished, a little room", voice: { warmth: 0, clarity: 0.35, air: 0.3, edge: 0, reverb: 0.3, echo: 0 } },
  { id: "warm", label: "Warm", hint: "Close and soft, for ballads", voice: { warmth: 0.5, clarity: 0.15, air: 0, edge: 0, reverb: 0.35, echo: 0 } },
  { id: "pop", label: "Pop shine", hint: "Bright and upfront, radio-ready", voice: { warmth: -0.15, clarity: 0.65, air: 0.7, edge: 0.1, reverb: 0.25, echo: 0.18 } },
  { id: "edge", label: "Raw edge", hint: "Gritty and harder, for power", voice: { warmth: -0.3, clarity: 0.8, air: 0.2, edge: 0.55, reverb: 0.15, echo: 0 } },
  { id: "dreamy", label: "Dreamy", hint: "Big space and echoes", voice: { warmth: 0.1, clarity: 0.2, air: 0.6, edge: 0, reverb: 0.75, echo: 0.4 } },
];

export const voiceFromPreset = (id: VoicePresetId, tune = 0): Voice => ({
  preset: id,
  tune,
  ...VOICE_PRESETS.find((p) => p.id === id)!.voice,
});

export const DEFAULT_VOICE: Voice = voiceFromPreset("natural");
export const PURE_VOICE: Voice = voiceFromPreset("pure");

export function impulse(ctx: BaseAudioContext, seconds = 2.6, power = 3.2, predelay = 0) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const pre = Math.floor(ctx.sampleRate * predelay);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = pre; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, power);
  }
  return buf;
}

export type VocalChain = { input: AudioNode; set(v: Voice, level: number, bpm: number): void };

function driveCurve(amount: number) {
  const n = 1024;
  const c = new Float32Array(n);
  const k = amount * 30;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}

/** HPF → warmth → clarity → air → edge → compressor → level, with a vocal plate and a tempo-synced echo on sends. */
export function buildVocalChain(ctx: BaseAudioContext, out: AudioNode): VocalChain {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  const warmth = ctx.createBiquadFilter();
  warmth.type = "peaking";
  warmth.frequency.value = 220;
  warmth.Q.value = 0.8;
  const clarity = ctx.createBiquadFilter();
  clarity.type = "peaking";
  clarity.frequency.value = 3500;
  clarity.Q.value = 0.7;
  const air = ctx.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 11000;
  const shaper = ctx.createWaveShaper();
  shaper.oversample = "2x";
  const comp = ctx.createDynamicsCompressor();
  const level = ctx.createGain();

  const revSend = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx, 2.4, 3.4, 0.025);
  const revRet = ctx.createGain();
  revRet.gain.value = 0.8;

  const echoSend = ctx.createGain();
  const delay = ctx.createDelay(2);
  const fb = ctx.createGain();
  fb.gain.value = 0.3;
  const dampen = ctx.createBiquadFilter();
  dampen.type = "lowpass";
  dampen.frequency.value = 3200;

  input.connect(hp).connect(warmth).connect(clarity).connect(air).connect(shaper).connect(comp).connect(level).connect(out);
  level.connect(revSend).connect(conv).connect(revRet).connect(out);
  level.connect(echoSend).connect(delay).connect(dampen).connect(out);
  dampen.connect(fb).connect(delay);
  dampen.connect(revSend); // echoes sit in the room too

  return {
    input,
    set(v, lvl, bpm) {
      const pure = v.preset === "pure";
      hp.frequency.value = pure ? 20 : 90;
      warmth.gain.value = v.warmth * 6;
      clarity.gain.value = v.clarity * 6;
      air.gain.value = v.air * 6;
      shaper.curve = v.edge > 0.01 ? driveCurve(v.edge) : null;
      comp.threshold.value = pure ? 0 : -22 - v.edge * 6;
      comp.ratio.value = pure ? 1 : 3.5 + v.edge * 2;
      comp.attack.value = 0.006;
      comp.release.value = 0.16;
      level.gain.value = lvl * (pure ? 1 : 1.45) * (1 - v.edge * 0.4); // makeup, minus drive gain
      revSend.gain.value = v.reverb * 0.9;
      echoSend.gain.value = v.echo * 0.55;
      delay.delayTime.value = Math.min(1.9, (60 / bpm) * 0.75);
    },
  };
}

export type MasterChain = { input: AudioNode; set(on: boolean): void };

export function buildMaster(ctx: BaseAudioContext, out: AudioNode): MasterChain {
  const input = ctx.createGain();
  const glue = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.knee.value = 0;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  input.connect(glue).connect(makeup).connect(limiter).connect(out);
  return {
    input,
    set(on) {
      glue.threshold.value = on ? -18 : 0;
      glue.ratio.value = on ? 2 : 1;
      glue.attack.value = 0.03;
      glue.release.value = 0.25;
      makeup.gain.value = on ? 1.35 : 1;
      limiter.threshold.value = on ? -1.5 : 0;
      limiter.ratio.value = on ? 20 : 1;
    },
  };
}

export type VocalClip = { data: Float32Array; sampleRate: number; offset: number }; // offset = song seconds of first sample

function clipBuffer(ctx: BaseAudioContext, v: VocalClip) {
  const b = ctx.createBuffer(1, v.data.length, v.sampleRate);
  b.copyToChannel(v.data as Float32Array<ArrayBuffer>, 0);
  return b;
}

function startClip(ctx: BaseAudioContext, v: VocalClip, dest: AudioNode) {
  const src = ctx.createBufferSource();
  src.buffer = clipBuffer(ctx, v);
  src.connect(dest);
  if (v.offset >= 0) src.start(v.offset);
  else src.start(0, -v.offset);
}

/** Vocal alone, through its chain, starting at song 0:00 so it lines up with the instrumental in any DAW. */
export async function renderVocalStem(v: VocalClip, voice: Voice, level: number, bpm: number, songSeconds: number, sampleRate = 44100) {
  const len = Math.ceil(Math.max(songSeconds, v.offset + v.data.length / v.sampleRate + 2.5) * sampleRate);
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const chain = buildVocalChain(ctx, ctx.destination);
  chain.set(voice, level, bpm);
  startClip(ctx, v, chain.input);
  return ceiling(await ctx.startRendering());
}

export async function renderMix(inst: AudioBuffer, v: VocalClip | null, voice: Voice, m: MixSettings, bpm: number) {
  const sr = inst.sampleRate;
  const vocalEnd = v ? v.offset + v.data.length / v.sampleRate + 2.5 : 0;
  const len = Math.ceil(Math.max(inst.duration, vocalEnd) * sr);
  const ctx = new OfflineAudioContext(2, len, sr);
  const master = buildMaster(ctx, ctx.destination);
  master.set(m.master);
  const instGain = ctx.createGain();
  instGain.gain.value = m.inst;
  instGain.connect(master.input);
  const src = ctx.createBufferSource();
  src.buffer = inst;
  src.connect(instGain);
  src.start(0);
  if (v) {
    const chain = buildVocalChain(ctx, master.input);
    chain.set(voice, m.vocal, bpm);
    startClip(ctx, v, chain.input);
  }
  return ceiling(await ctx.startRendering());
}

/** Never let an export clip: pull the whole file down if it peaks above -0.5 dBFS. */
function ceiling(buf: AudioBuffer, max = 0.944) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
  if (peak > max) for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const g = max / peak;
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

/** 16-bit PCM WAV. Hand-rolled because it's a tight loop and we want it fast. */
export function wav16(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(out);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * ch * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * ch * 2, true);
  const pcm = new Int16Array(out, 44);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  for (let i = 0, k = 0; i < n; i++)
    for (let c = 0; c < ch; c++, k++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  return new Uint8Array(out);
}

export function zip(files: Record<string, Uint8Array>) {
  return zipSync(files, { level: 0 }); // WAV doesn't compress; store is instant
}

export function download(data: Uint8Array | Blob, name: string, type = "audio/wav") {
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
