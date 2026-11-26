// Vocal chain, mastering chain, offline mixdowns, WAV + zip encoding.
import { zipSync } from "fflate";

export type VocalMode = "pure" | "natural" | "tuned";
export type MixSettings = {
  inst: number; // instrumental level 0..1.2
  vocal: number; // vocal level 0..1.5
  vocalReverb: number; // 0..1
  mode: VocalMode;
  tune: number; // auto-tune strength 0..1
  master: boolean; // glue compression + limiter on the full mix
  latencyMs: number; // manual nudge for take alignment (+ = move vocal earlier)
};

export const DEFAULT_MIX: MixSettings = {
  inst: 0.85,
  vocal: 1,
  vocalReverb: 0.3,
  mode: "natural",
  tune: 0.8,
  master: true,
  latencyMs: 0,
};

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

export type VocalChain = { input: AudioNode; set(m: MixSettings): void };

/** HPF → presence → compressor → level, with a short vocal plate on a send. */
export function buildVocalChain(ctx: BaseAudioContext, out: AudioNode): VocalChain {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 3800;
  presence.Q.value = 0.7;
  const air = ctx.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor();
  const level = ctx.createGain();
  const send = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx, 2.2, 3.6, 0.025);
  const ret = ctx.createGain();
  ret.gain.value = 0.8;

  input.connect(hp).connect(presence).connect(air).connect(comp).connect(level).connect(out);
  level.connect(send).connect(conv).connect(ret).connect(out);

  return {
    input,
    set(m) {
      const pure = m.mode === "pure";
      hp.frequency.value = pure ? 20 : 95;
      presence.gain.value = pure ? 0 : 2.5;
      air.gain.value = pure ? 0 : 2;
      comp.threshold.value = pure ? 0 : -24;
      comp.ratio.value = pure ? 1 : 3.5;
      comp.attack.value = 0.006;
      comp.release.value = 0.16;
      level.gain.value = m.vocal * (pure ? 1 : 1.6); // makeup for the compressor
      send.gain.value = pure ? 0 : m.vocalReverb * 0.9;
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
export async function renderVocalStem(v: VocalClip, m: MixSettings, songSeconds: number, sampleRate = 44100) {
  const len = Math.ceil(Math.max(songSeconds, v.offset + v.data.length / v.sampleRate + 2.5) * sampleRate);
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const chain = buildVocalChain(ctx, ctx.destination);
  chain.set(m);
  startClip(ctx, v, chain.input);
  return ctx.startRendering();
}

export async function renderMix(inst: AudioBuffer, v: VocalClip | null, m: MixSettings) {
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
    chain.set(m);
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
