// A small FLAC encoder for mono vocal takes (16-bit, fixed 4096-sample blocks, fixed predictors 0–4,
// Rice-coded residuals). Lossless for the 16-bit signal, typically ~50–60% of the raw size.
// Decoding goes through the browser's own FLAC decoder.

const BLOCK = 4096;

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
const crc8 = (b: Uint8Array, from: number, to: number) => {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ b[i]];
  return c;
};
const crc16 = (b: Uint8Array, from: number, to: number) => {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
};

class BitWriter {
  buf: Uint8Array;
  pos = 0; // byte position
  acc = 0; // pending bits (< 8)
  n = 0;
  constructor(cap: number) {
    this.buf = new Uint8Array(cap);
  }
  private grow(extra: number) {
    if (this.pos + extra < this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 1024));
    next.set(this.buf);
    this.buf = next;
  }
  /** Write the low `bits` bits of `v` (bits ≤ 24 per call). */
  write(v: number, bits: number) {
    if (bits > 24) {
      this.write(Math.floor(v / 2 ** 24), bits - 24);
      this.write(v % 2 ** 24, 24);
      return;
    }
    this.grow(4);
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }
  zeros(count: number) {
    while (count > 24) {
      this.write(0, 24);
      count -= 24;
    }
    if (count) this.write(0, count);
  }
  align() {
    if (this.n) this.write(0, 8 - this.n);
  }
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

function utf8Num(w: BitWriter, v: number) {
  if (v < 0x80) return w.write(v, 8);
  const len = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  w.write(((0xff00 >> len) & 0xff) | Math.floor(v / 2 ** (6 * (len - 1))), 8);
  for (let i = len - 2; i >= 0; i--) w.write(0x80 | (Math.floor(v / 2 ** (6 * i)) & 0x3f), 8);
}

/** Fixed-predictor residuals (orders 0–4) for one block, written into `out` from index `order`. */
function residual(s: Int32Array, order: number, out: Int32Array) {
  const n = s.length;
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: out[i] = s[i]; break;
      case 1: out[i] = s[i] - s[i - 1]; break;
      case 2: out[i] = s[i] - 2 * s[i - 1] + s[i - 2]; break;
      case 3: out[i] = s[i] - 3 * s[i - 1] + 3 * s[i - 2] - s[i - 3]; break;
      default: out[i] = s[i] - 4 * s[i - 1] + 6 * s[i - 2] - 4 * s[i - 3] + s[i - 4];
    }
  }
}

const zig = (r: number) => (r >= 0 ? 2 * r : -2 * r - 1);

/** Best Rice parameter 0–14 and the exact bit cost of the residual section (partition order 0). */
function bestRice(res: Int32Array, from: number): { k: number; bits: number } {
  const n = res.length - from;
  if (n <= 0) return { k: 0, bits: 6 + 4 };
  let sum = 0;
  for (let i = from; i < res.length; i++) sum += zig(res[i]);
  const guess = Math.max(0, Math.min(14, Math.floor(Math.log2(Math.max(1, sum / n)))));
  let best = { k: 0, bits: Infinity };
  for (let k = Math.max(0, guess - 1); k <= Math.min(14, guess + 1); k++) {
    let q = 0;
    for (let i = from; i < res.length; i++) q += zig(res[i]) >>> k;
    const bits = 6 + 4 + q + n * (k + 1);
    if (bits < best.bits) best = { k, bits };
  }
  return best;
}

export function encodeFlac(data: Float32Array, sampleRate: number): Uint8Array {
  const total = data.length;
  const w = new BitWriter(Math.ceil(total * 1.2) + 4096);

  // "fLaC" + STREAMINFO (last metadata block)
  [0x66, 0x4c, 0x61, 0x43].forEach((b) => w.write(b, 8));
  w.write(1, 1);
  w.write(0, 7);
  w.write(34, 24);
  w.write(BLOCK, 16); // min block size
  w.write(BLOCK, 16); // max block size
  w.write(0, 24); // min frame size (unknown)
  w.write(0, 24); // max frame size (unknown)
  w.write(sampleRate, 20);
  w.write(0, 3); // channels - 1
  w.write(15, 5); // bits per sample - 1
  w.write(total, 36);
  w.zeros(128); // MD5 (not computed)

  const s = new Int32Array(BLOCK);
  const res = new Int32Array(BLOCK);
  for (let frame = 0, start = 0; start < total; frame++, start += BLOCK) {
    const n = Math.min(BLOCK, total - start);
    const blk = s.subarray(0, n);
    for (let i = 0; i < n; i++) {
      const v = Math.round(data[start + i] * 32768);
      blk[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }

    const hdr = w.pos;
    w.write(0b11111111111110, 14); // sync
    w.write(0, 1); // reserved
    w.write(0, 1); // fixed blocksize stream
    w.write(0b0111, 4); // block size: 16-bit (n-1) follows
    w.write(0b0000, 4); // sample rate: from STREAMINFO
    w.write(0b0000, 4); // mono
    w.write(0b100, 3); // 16 bits per sample
    w.write(0, 1); // reserved
    utf8Num(w, frame);
    w.write(n - 1, 16);
    w.write(crc8(w.buf, hdr, w.pos), 8);

    // pick the cheapest fixed predictor, or VERBATIM
    let best = { order: -1, k: 0, bits: 16 * n };
    for (let order = 0; order <= 4 && order < n; order++) {
      const r = res.subarray(0, n);
      residual(blk, order, r);
      const rice = bestRice(r, order);
      const bits = 16 * order + rice.bits;
      if (bits < best.bits) best = { order, k: rice.k, bits };
    }

    if (best.order < 0) {
      w.write(0b00000010, 8); // pad 0, VERBATIM (000001), no wasted bits
      for (let i = 0; i < n; i++) w.write(blk[i] & 0xffff, 16);
    } else {
      const { order, k } = best;
      w.write(0, 1);
      w.write(0b001000 | order, 6); // FIXED, order
      w.write(0, 1); // no wasted bits
      for (let i = 0; i < order; i++) w.write(blk[i] & 0xffff, 16);
      const r = res.subarray(0, n);
      residual(blk, order, r);
      w.write(0b00, 2); // Rice, 4-bit parameters
      w.write(0, 4); // partition order 0
      w.write(k, 4);
      for (let i = order; i < n; i++) {
        const u = zig(r[i]);
        w.zeros(u >>> k);
        w.write(1, 1);
        if (k) w.write(u & ((1 << k) - 1), k);
      }
    }
    w.align();
    w.write(crc16(w.buf, hdr, w.pos), 16);
  }
  return w.bytes().slice();
}

/** Decode FLAC bytes back to mono Float32 at `sampleRate`, using the browser's decoder. */
export async function decodeFlac(bytes: Uint8Array | ArrayBuffer, sampleRate: number): Promise<Float32Array> {
  const buf = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const audio = await ctx.decodeAudioData(buf as ArrayBuffer);
  return audio.getChannelData(0).slice();
}
