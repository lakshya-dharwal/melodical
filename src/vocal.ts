// Mic capture timestamped against the AudioContext clock, plus offline pitch correction.
import { parseChord } from "./theory";

const WORKLET = `
class MelRec extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.t = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.t = currentTime;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= 4096 - 128) {
        this.port.postMessage({ t: this.t, d: this.buf.slice(0, this.n) });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("mel-rec", MelRec);
`;

export class MicRecorder {
  private stream: MediaStream | null = null;
  private chunks: { t: number; d: Float32Array }[] = [];
  private recording = false;
  level = 0; // live input meter, 0..1

  constructor(private ctx: AudioContext) {}

  get ready() {
    return !!this.stream;
  }

  async init() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Raw voice: browser "call" processing smears singing.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, "mel-rec", { channelCount: 1, channelCountMode: "explicit" });
    node.port.onmessage = (e: MessageEvent<{ t: number; d: Float32Array }>) => {
      let peak = 0;
      for (let i = 0; i < e.data.d.length; i += 8) peak = Math.max(peak, Math.abs(e.data.d[i]));
      this.level = Math.max(peak, this.level * 0.7);
      if (this.recording) this.chunks.push(e.data);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(this.ctx.destination);
  }

  /** Seconds between "sound leaves the speakers" and "mic sample arrives", as well as the browser can tell. */
  roundTripLatency() {
    const track = this.stream?.getAudioTracks()[0];
    const input = (track?.getSettings() as { latency?: number })?.latency ?? 0.01;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) + input;
  }

  start() {
    this.chunks = [];
    this.recording = true;
  }

  stop(): { t0: number; data: Float32Array } | null {
    this.recording = false;
    if (!this.chunks.length) return null;
    const total = this.chunks.reduce((a, c) => a + c.d.length, 0);
    const data = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      data.set(c.d, o);
      o += c.d.length;
    }
    const t0 = this.chunks[0].t;
    this.chunks = [];
    return { t0, data };
  }
}

// ---------- key detection ----------

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Pick the major/relative-minor scale that best covers the song's chord tones. */
export function detectScale(symbols: string[]): number[] {
  const hist = new Array(12).fill(0);
  for (const s of symbols) {
    const ch = parseChord(s);
    if (!ch) continue;
    for (const o of ch.offsets) hist[(ch.root + o) % 12] += 1;
    hist[ch.root] += 1;
  }
  let best = 0;
  let bestScore = -1;
  for (let k = 0; k < 12; k++) {
    const score = MAJOR.reduce((a, d) => a + hist[(k + d) % 12], 0);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return MAJOR.map((d) => (best + d) % 12);
}

// ---------- pitch tracking (YIN on a 4x-decimated signal) ----------

function trackPitch(x: Float32Array, sr: number, hop: number) {
  const D = 4;
  const dsr = sr / D;
  const n = Math.floor(x.length / D);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = (x[i * D] + x[i * D + 1] + x[i * D + 2] + x[i * D + 3]) * 0.25;
  const W = 512;
  const minLag = Math.floor(dsr / 900);
  const maxLag = Math.ceil(dsr / 75);
  const frames = Math.floor(x.length / hop);
  const f0 = new Float32Array(frames);
  const diff = new Float32Array(maxLag + 1);
  for (let f = 0; f < frames; f++) {
    const start = Math.floor((f * hop) / D) - W / 2;
    if (start < 0 || start + W + maxLag >= n) continue;
    let energy = 0;
    for (let i = 0; i < W; i++) energy += y[start + i] * y[start + i];
    if (energy / W < 2e-5) continue; // silence
    for (let lag = 1; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const d = y[start + i] - y[start + i + lag];
        s += d * d;
      }
      diff[lag] = s;
    }
    // cumulative mean normalised difference
    let run = 0;
    let found = -1;
    for (let lag = 1; lag <= maxLag; lag++) {
      run += diff[lag];
      const c = (diff[lag] * lag) / (run || 1);
      diff[lag] = c;
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (diff[lag] < 0.15) {
        while (lag + 1 <= maxLag && diff[lag + 1] < diff[lag]) lag++;
        found = lag;
        break;
      }
    }
    if (found < 0) continue;
    const a = diff[found - 1] ?? diff[found];
    const b = diff[found];
    const c = diff[found + 1] ?? diff[found];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    f0[f] = dsr / (found + Math.max(-1, Math.min(1, shift)));
  }
  // median-of-3 to kill octave blips
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = [f0[i - 1] ?? 0, f0[i], f0[i + 1] ?? 0].sort((p, q) => p - q);
    out[i] = f0[i] ? v[1] || f0[i] : 0;
  }
  return out;
}

// ---------- TD-PSOLA pitch correction ----------

/**
 * Snaps the sung pitch toward the nearest note in `scale`. strength 1 = hard (the "auto-tune" sound),
 * lower = gentler correction. Mono in, mono out, same length.
 */
export function autotune(x: Float32Array, sr: number, scale: number[], strength: number): Float32Array {
  const hop = 256;
  const f0 = trackPitch(x, sr, hop);
  const frames = f0.length;

  // target ratio per frame, smoothed so note transitions glide a little
  const ratio = new Float32Array(frames).fill(1);
  const allowed = new Set(scale);
  for (let f = 0; f < frames; f++) {
    if (!f0[f]) continue;
    const midi = 69 + 12 * Math.log2(f0[f] / 440);
    let target = Math.round(midi);
    let bestDist = Infinity;
    for (let c = Math.round(midi) - 6; c <= Math.round(midi) + 6; c++) {
      if (!allowed.has(((c % 12) + 12) % 12)) continue;
      const d = Math.abs(c - midi);
      if (d < bestDist) {
        bestDist = d;
        target = c;
      }
    }
    ratio[f] = Math.pow(2, ((target - midi) * strength) / 12);
  }
  const speed = 0.35 + strength * 0.6; // retune speed
  for (let f = 1; f < frames; f++) if (f0[f] && f0[f - 1]) ratio[f] = ratio[f - 1] + (ratio[f] - ratio[f - 1]) * speed;

  // analysis marks: one per pitch period in voiced regions (snapped to local peaks), fixed spacing elsewhere
  const marks: number[] = [];
  const periods: number[] = [];
  let t = 0;
  while (t < x.length) {
    const f = Math.min(frames - 1, Math.floor(t / hop));
    const p = f0[f] ? sr / f0[f] : hop;
    let m = Math.floor(t);
    if (f0[f]) {
      const r = Math.floor(p * 0.25);
      let best = m;
      for (let i = Math.max(0, m - r); i < Math.min(x.length, m + r); i++) if (x[i] > x[best]) best = i;
      m = Math.max(marks.length ? marks[marks.length - 1] + Math.floor(p * 0.6) : 0, best);
    }
    marks.push(m);
    periods.push(p);
    t = m + p;
  }

  const out = new Float32Array(x.length);
  const wsum = new Float32Array(x.length);
  let ts = 0;
  let k = 0;
  while (ts < x.length && marks.length) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1] - ts) < Math.abs(marks[k] - ts)) k++;
    const m = marks[k];
    const P = Math.max(32, Math.floor(periods[k]));
    const f = Math.min(frames - 1, Math.floor(m / hop));
    const r = f0[f] ? ratio[f] : 1;
    const center = Math.floor(ts);
    for (let i = -P; i < P; i++) {
      const si = m + i;
      const oi = center + i;
      if (si < 0 || si >= x.length || oi < 0 || oi >= x.length) continue;
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + P)) / P);
      out[oi] += x[si] * w;
      wsum[oi] += w;
    }
    ts += P / r;
  }
  for (let i = 0; i < out.length; i++) out[i] = wsum[i] > 0.1 ? out[i] / wsum[i] : out[i];
  return out;
}
