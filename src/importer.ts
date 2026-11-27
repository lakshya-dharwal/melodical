// Bring-your-own-chords: turn loosely written charts (ChatGPT answers, notes, spreadsheets,
// screenshots) into our Section list, then into a full Song of a chosen length.

import {
  BEATS_PER_BAR,
  isValidChord,
  parseChordMap,
  type ChordSlot,
  type Section,
  type Song,
  type StructureItem,
} from "./song";

export type LooseResult = { sections: Section[]; bpm?: number; warnings: string[] };

/** Normalise one loosely spelled chord token. Returns null when it isn't a chord. */
export function toChord(token: string): ChordSlot | null {
  let t = token.trim().replace(/^[([{"'“‘]+/, "");
  let bars = 1;
  const barM = t.match(/\((\d+(?:\/\d+)?)\)$/);
  if (barM) {
    const [a, b] = barM[1].split("/").map(Number);
    bars = b ? a / b : a || 1;
    t = t.slice(0, -barM[0].length);
  }
  t = t.replace(/[.,;:!?)\]}"'”’]+$/, "");
  if (!t) return null;
  if (/^(n\.?c\.?|%)$/i.test(t)) return { symbol: t === "%" ? "%" : "N.C.", bars };
  t = t
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    .replace(/[Δ∆]/g, "maj7")
    .replace(/°/g, "dim")
    .replace(/ø/g, "m7b5");
  const m = t.match(/^([A-G])([#b]?)(.*)$/);
  if (!m) return null;
  const [, root, acc] = m;
  let rest = m[3];
  let bass = "";
  const slash = rest.match(/^(.*)\/([A-Ga-g][#b]?)$/);
  if (slash) {
    rest = slash[1];
    bass = "/" + slash[2][0].toUpperCase() + slash[2].slice(1);
  }
  rest = rest
    .replace(/^(min|mi|-)(?=$|\d|maj|b|#|add|sus)/, "m")
    .replace(/^M(?=7|9|11|13)/, "maj")
    .replace(/^(Maj|MAJ|ma)(?=7|9|11|13)/, "maj")
    .replace(/^(major|maj)$/i, "");
  const symbol = root + acc + rest + bass;
  if (!isValidChord(symbol)) return null;
  return { symbol, bars };
}

const SECTION_WORDS =
  /^(verse|chorus|hook|refrain|mukhda|antara|pre[- ]?chorus|post[- ]?chorus|bridge|intro|outro|instrumental|interlude|solo|break|middle ?8|ending|coda|tag|sthayi|sthai|stanza|part)\b/i;

/** Drop markdown / bullet decoration around a line. */
function stripDecor(s: string) {
  return s
    .replace(/^\s*(?:[#>*•·\-–—]+|\d+[.)])\s*/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/^\[(.+)\]$/, "$1")
    .replace(/^\((.+)\)$/, "$1")
    .trim();
}

const isNoise = (tok: string) => /^(x\s*\d+|\d+\s*x|[x×]\d+|\(?[x×]\d+\)?|\d+|[|/\\\-–—:]+|bars?|repeat)$/i.test(tok);

function chordsOf(line: string): { chords: ChordSlot[]; ratio: number } {
  const tokens = line
    .replace(/[|│┃]/g, " ")
    .replace(/\s+[-–—→>]\s+/g, " ")
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !isNoise(t));
  if (!tokens.length) return { chords: [], ratio: 0 };
  const chords: ChordSlot[] = [];
  let hits = 0;
  for (const tok of tokens) {
    const c = toChord(tok);
    if (!c) continue;
    hits++;
    if (c.symbol === "%") {
      const prev = chords[chords.length - 1];
      if (prev) chords.push({ ...prev, bars: c.bars });
    } else chords.push(c);
  }
  return { chords, ratio: hits / tokens.length };
}

function cleanName(raw: string) {
  let s = raw
    .replace(/\s*\(?[x×]\s*\d+\)?\s*$/i, "")
    .replace(/\s*\(?\d+\s*[x×]\)?\s*$/i, "")
    .replace(/[:\-–—=]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 2 && s === s.toUpperCase()) s = s.toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : "Part";
}

function looksLikeChordMap(text: string) {
  const t = text.trim();
  return t.startsWith("{") || (/^\[[^\]]+\]\s*$/m.test(t) && /^(tempo|bpm|structure|title)\s*:/im.test(t));
}

/** Read chords out of anything a singer might paste. */
export function parseLoose(text: string): LooseResult {
  const warnings: string[] = [];
  if (!text.trim()) return { sections: [], warnings };

  if (looksLikeChordMap(text)) {
    const { song, warnings: w } = parseChordMap(text);
    if (song.sections.length) {
      const bpm = /(tempo|bpm)\s*:|"(tempo|bpm)"/i.test(text) ? song.bpm : undefined;
      return { sections: song.sections, bpm, warnings: w };
    }
  }

  let bpm: number | undefined;
  const bpmM = text.match(/(\d{2,3})\s*bpm\b/i) ?? text.match(/\b(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})\b/i);
  if (bpmM) {
    const n = Number(bpmM[1]);
    if (n >= 40 && n <= 220) bpm = n;
  }

  const sections: Section[] = [];
  let pending: string | null = null;
  let current: Section | null = null;
  let skipped = 0;

  const add = (chords: ChordSlot[]) => {
    if (pending !== null || !current) {
      current = { name: pending ?? (sections.length ? `Part ${sections.length + 1}` : "Main"), chords: [] };
      sections.push(current);
      pending = null;
    }
    current.chords.push(...chords);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripDecor(raw);
    if (!line) continue;
    if (/^(title|tempo|bpm|key|structure|form|capo|time|song|artist)\b\s*[:=]/i.test(line) || /^\d{2,3}\s*bpm$/i.test(line)) continue;

    // "Verse: Am F C G" / "Chorus - C G Am F"
    const labelled = line.match(/^([A-Za-z][\w '’()-]{0,30}?)\s*[:=–—]\s*(.*)$/) ?? line.match(/^([A-Za-z][\w '’()]{0,30}?)\s+-\s+(.+)$/);
    if (labelled && !toChord(labelled[1].trim())) {
      const { chords, ratio } = chordsOf(labelled[2]);
      if (chords.length && ratio >= 0.6) {
        pending = cleanName(labelled[1]);
        add(chords);
        continue;
      }
      const shortLabel = labelled[1].trim().split(/\s+/).length <= 3;
      if (!chords.length && (SECTION_WORDS.test(labelled[1]) || (!labelled[2].trim() && shortLabel))) {
        pending = cleanName(labelled[1]);
        continue;
      }
    }

    const { chords, ratio } = chordsOf(line);
    if (chords.length && ratio >= 0.6) {
      add(chords);
      continue;
    }

    const words = line.split(/\s+/);
    if (SECTION_WORDS.test(line) || (words.length <= 3 && line.length <= 24 && /[A-Za-z]/.test(line) && !/[.!?,]$/.test(line))) {
      pending = cleanName(line);
      continue;
    }
    skipped++;
  }

  // Same name twice: identical chords are dropped, different chords become "Chorus 2".
  const out: Section[] = [];
  const seen = new Map<string, Section[]>();
  const sig = (x: Section) => x.chords.map((c) => c.symbol + ":" + c.bars).join(" ");
  for (const s of sections) {
    if (!s.chords.length) continue;
    const key = s.name.toLowerCase();
    const same = seen.get(key) ?? [];
    if (same.some((x) => sig(x) === sig(s))) continue;
    const named = same.length ? { ...s, name: `${s.name} ${same.length + 1}` } : s;
    seen.set(key, [...same, s]);
    out.push(named);
  }

  if (!out.length) warnings.push("No chords found yet. Try one section per line, like: Verse: Am F C G");
  else if (skipped) warnings.push(`Skipped ${skipped} line${skipped > 1 ? "s" : ""} that looked like lyrics or notes`);
  return { sections: out, bpm, warnings };
}

const sectionBars = (s: Section) => s.chords.reduce((n, c) => n + c.bars, 0);

/** Repeat the sections in order until the song reaches `minutes` (null = once through). */
export function buildSong(name: string, bpm: number, sections: Section[], minutes: number | null): Song {
  const secPerBar = (BEATS_PER_BAR * 60) / bpm;
  const pass = sections.map((s) => s.name);
  const order = [...pass];
  if (minutes && sections.length) {
    const target = minutes * 60;
    const passSec = sections.reduce((t, s) => t + sectionBars(s) * secPerBar, 0);
    let total = passSec;
    // Add whole passes while that lands closer to the target.
    while (passSec > 0 && Math.abs(total + passSec - target) < Math.abs(total - target) && order.length < 400) {
      order.push(...pass);
      total += passSec;
    }
  }
  const structure: StructureItem[] = [];
  for (const n of order) {
    const last = structure[structure.length - 1];
    if (last && last.name === n) last.repeat++;
    else structure.push({ name: n, repeat: 1 });
  }
  return { title: name, bpm, sections, structure };
}

export function songSeconds(song: Song) {
  const bars = new Map(song.sections.map((s) => [s.name, sectionBars(s)]));
  const total = song.structure.reduce((n, st) => n + (bars.get(st.name) ?? 0) * st.repeat, 0);
  return (total * BEATS_PER_BAR * 60) / song.bpm;
}

export const ACCEPT = ".txt,.text,.md,.csv,.tsv,.json,.xlsx,.xls,text/*,image/*,application/json";

// ---------- files ----------

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Upscale, greyscale, flip dark screenshots to dark-on-light, and stretch contrast. */
async function preprocess(file: File): Promise<HTMLCanvasElement> {
  const img = await loadImage(file);
  const scale = Math.min(4, Math.max(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight)));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const grey = new Uint8ClampedArray(w * h);
  let sum = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    grey[j] = g;
    sum += g;
  }
  const invert = sum / grey.length < 128;
  if (invert) for (let j = 0; j < grey.length; j++) grey[j] = 255 - grey[j];
  // Stretch the 2%..98% range to full black..white.
  const hist = new Uint32Array(256);
  for (let j = 0; j < grey.length; j++) hist[grey[j]]++;
  const cut = grey.length * 0.02;
  let lo = 0;
  let hi = 255;
  for (let v = 0, acc = 0; v < 256; v++) if ((acc += hist[v]) > cut) { lo = v; break; }
  for (let v = 255, acc = 0; v >= 0; v--) if ((acc += hist[v]) > cut) { hi = v; break; }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((grey[j] - lo) / span) * 255));
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** Read any supported file into plain text for parseLoose. */
export async function fileToText(file: File, onStatus: (s: string) => void): Promise<string> {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) {
    onStatus("Getting the picture ready…");
    const canvas = await preprocess(file);
    onStatus("Loading the chord reader…");
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, {
      logger: (m: { status: string; progress: number }) => {
        if (m.status === "recognizing text") onStatus(`Reading chords from the picture… ${Math.round(m.progress * 100)}%`);
      },
    });
    try {
      await worker.setParameters({ preserve_interword_spaces: "1" });
      const { data } = await worker.recognize(canvas);
      return data.text;
    } finally {
      await worker.terminate();
    }
  }
  if (name.endsWith(".xls")) throw new Error("Old .xls files can't be read here. Save it as .xlsx or CSV and try again.");
  if (name.endsWith(".xlsx")) {
    onStatus("Reading the spreadsheet…");
    const { readSheet } = await import("read-excel-file/browser");
    const rows = await readSheet(file);
    return rows
      .map((r) => r.filter((c) => c !== null && c !== undefined && String(c).trim() !== "").map(String).join(" "))
      .filter(Boolean)
      .join("\n");
  }
  onStatus("Reading the file…");
  const text = await file.text();
  return /\.(csv|tsv)$/.test(name) ? text.replace(/[,\t;]+/g, " ").replace(/"/g, "") : text;
}
