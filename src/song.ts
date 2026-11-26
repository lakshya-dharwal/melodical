// Song model + the "chord map" text format.
//
//   title: Aaina
//   tempo: 80
//
//   [Mukhda]
//   Am Fmaj7 C G          <- one bar each by default
//   Am(2) G(1/2) F(1/2)   <- (n) = bars, fractions allowed
//   %                     <- repeat previous chord, N.C. = silence
//
//   structure: Mukhda x2, Pre-chorus, Mukhda, Antara 1
//
// JSON upload is also accepted (see parseJson).

import { Chord } from "tonal";

export const BEATS_PER_BAR = 4;

export type ChordSlot = { symbol: string; bars: number };
export type Section = { name: string; chords: ChordSlot[] };
export type StructureItem = { name: string; repeat: number };
export type Song = {
  title: string;
  bpm: number;
  sections: Section[];
  structure: StructureItem[];
};

/** One played occurrence of a section, laid out on the beat timeline. */
export type Block = {
  index: number;
  sectionIndex: number;
  name: string;
  startBeat: number;
  beats: number;
  chords: { symbol: string; startBeat: number; beats: number; slot: number }[];
};

export type ParseResult = { song: Song; warnings: string[] };

const REST = new Set(["N.C.", "NC", "-", "x"]);

export function isRest(symbol: string) {
  return REST.has(symbol);
}

export function isValidChord(symbol: string) {
  if (isRest(symbol)) return true;
  const [main, bass] = symbol.split("/");
  if (Chord.get(main).empty) return false;
  if (bass && !/^[A-G][#b]?$/.test(bass)) return false;
  return true;
}

function parseBars(raw: string | undefined): number {
  if (!raw) return 1;
  if (raw.includes("/")) {
    const [a, b] = raw.split("/").map(Number);
    return b ? a / b : 1;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function parseChordLine(line: string, prev: ChordSlot | undefined, warnings: string[]): ChordSlot[] {
  const out: ChordSlot[] = [];
  const tokens = line.replace(/\|/g, " ").split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const m = tok.match(/^(.+?)(?:\(([\d./]+)\)|\*([\d./]+))?$/);
    if (!m) continue;
    let symbol = m[1];
    const bars = parseBars(m[2] ?? m[3]);
    if (symbol === "%") {
      const last = out[out.length - 1] ?? prev;
      if (!last) continue;
      symbol = last.symbol;
    }
    if (!isValidChord(symbol)) warnings.push(`"${symbol}" isn't a chord I know, it'll be silent`);
    out.push({ symbol, bars });
  }
  return out;
}

export function parseChordMap(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return parseJson(trimmed);

  const warnings: string[] = [];
  const song: Song = { title: "Untitled", bpm: 90, sections: [], structure: [] };
  let current: Section | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const meta = line.match(/^(title|tempo|bpm|structure|form)\s*:\s*(.*)$/i);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === "title") song.title = val;
      else if (key === "tempo" || key === "bpm") song.bpm = clampBpm(parseFloat(val));
      else song.structure = parseStructure(val);
      continue;
    }

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = { name: header[1].trim(), chords: [] };
      song.sections.push(current);
      continue;
    }

    if (!current) {
      current = { name: "Main", chords: [] };
      song.sections.push(current);
    }
    current.chords.push(...parseChordLine(line, current.chords[current.chords.length - 1], warnings));
  }

  song.sections = song.sections.filter((s) => s.chords.length > 0);
  finalizeStructure(song, warnings);
  return { song, warnings };
}

function parseStructure(val: string): StructureItem[] {
  return val
    .split(/[,→>]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.+?)\s*[x×]\s*(\d+)$/i);
      return m ? { name: m[1].trim(), repeat: Number(m[2]) } : { name: s, repeat: 1 };
    });
}

function finalizeStructure(song: Song, warnings: string[]) {
  const names = new Set(song.sections.map((s) => s.name.toLowerCase()));
  if (song.structure.length === 0) {
    song.structure = song.sections.map((s) => ({ name: s.name, repeat: 1 }));
    return;
  }
  song.structure = song.structure.filter((item) => {
    const ok = names.has(item.name.toLowerCase());
    if (!ok) warnings.push(`structure mentions "${item.name}" but there's no [${item.name}] section`);
    return ok;
  });
}

type JsonSong = {
  title?: string;
  tempo?: number;
  bpm?: number;
  sections?: { name: string; chords: (string | { chord?: string; symbol?: string; bars?: number })[] }[];
  structure?: (string | { name: string; repeat?: number })[];
};

function parseJson(text: string): ParseResult {
  const warnings: string[] = [];
  let data: JsonSong;
  try {
    data = JSON.parse(text);
  } catch {
    return { song: emptySong(), warnings: ["That JSON didn't parse"] };
  }
  const song: Song = {
    title: data.title ?? "Untitled",
    bpm: clampBpm(data.tempo ?? data.bpm ?? 90),
    sections: (data.sections ?? []).map((s) => ({
      name: s.name,
      chords: s.chords.map((c) =>
        typeof c === "string"
          ? { symbol: c, bars: 1 }
          : { symbol: c.chord ?? c.symbol ?? "N.C.", bars: c.bars ?? 1 },
      ),
    })),
    structure: (data.structure ?? []).map((s) =>
      typeof s === "string" ? parseStructure(s)[0] : { name: s.name, repeat: s.repeat ?? 1 },
    ),
  };
  for (const s of song.sections)
    for (const c of s.chords) if (!isValidChord(c.symbol)) warnings.push(`"${c.symbol}" isn't a chord I know`);
  finalizeStructure(song, warnings);
  return { song, warnings };
}

function clampBpm(n: number) {
  return Number.isFinite(n) ? Math.min(220, Math.max(40, Math.round(n))) : 90;
}

export function emptySong(): Song {
  return { title: "Untitled", bpm: 90, sections: [], structure: [] };
}

function fmtBars(bars: number) {
  if (bars === 1) return "";
  if (Number.isInteger(bars)) return `(${bars})`;
  const map: Record<number, string> = { 0.5: "1/2", 0.25: "1/4", 0.75: "3/4", 1.5: "3/2" };
  return `(${map[bars] ?? bars})`;
}

export function serializeSong(song: Song): string {
  const lines = [`title: ${song.title}`, `tempo: ${song.bpm}`, ""];
  for (const s of song.sections) {
    lines.push(`[${s.name}]`);
    const chunks: string[] = [];
    for (let i = 0; i < s.chords.length; i += 4)
      chunks.push(s.chords.slice(i, i + 4).map((c) => c.symbol + fmtBars(c.bars)).join("  "));
    lines.push(...chunks, "");
  }
  lines.push(
    "structure: " + song.structure.map((st) => (st.repeat > 1 ? `${st.name} x${st.repeat}` : st.name)).join(", "),
  );
  return lines.join("\n");
}

/** Lay the structure out on a beat timeline. Repeats are separate blocks so the UI can show them. */
export function layout(song: Song): { blocks: Block[]; totalBeats: number } {
  const byName = new Map(song.sections.map((s, i) => [s.name.toLowerCase(), i]));
  const blocks: Block[] = [];
  let beat = 0;
  for (const item of song.structure) {
    const si = byName.get(item.name.toLowerCase());
    if (si === undefined) continue;
    const section = song.sections[si];
    for (let r = 0; r < item.repeat; r++) {
      const start = beat;
      const chords = section.chords.map((c, slot) => {
        const ch = { symbol: c.symbol, startBeat: beat, beats: c.bars * BEATS_PER_BAR, slot };
        beat += ch.beats;
        return ch;
      });
      blocks.push({ index: blocks.length, sectionIndex: si, name: section.name, startBeat: start, beats: beat - start, chords });
    }
  }
  return { blocks, totalBeats: beat };
}

export function beatsToSeconds(beats: number, bpm: number) {
  return (beats * 60) / bpm;
}

export function fmtTime(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Plain-English meaning of common section names, shown next to each section.
const SECTION_HINTS: [RegExp, string][] = [
  [/^mukhda/i, "the hook, the line people remember"],
  [/^antara/i, "the story part between hooks"],
  [/^verse/i, "the story part"],
  [/^pre-?chorus/i, "the build-up into the hook"],
  [/^chorus|^hook/i, "the hook, the line people remember"],
  [/^bridge/i, "a change of mood before the last hook"],
  [/^intro/i, "how the song opens"],
  [/^outro/i, "how the song ends"],
  [/^instrumental|^solo/i, "music only, no singing"],
];
export function sectionHint(name: string) {
  return SECTION_HINTS.find(([re]) => re.test(name))?.[1];
}

export type Starter = {
  id: string;
  name: string;
  feels: string; // one plain line for beginners
  bpm: number;
  instrument: string;
  style: "ballad" | "arpeggio" | "strum" | "sustain" | "pulse";
  text: string;
};

// Popular progressions, slowest to fastest. Each comes fully set up: chords, form, instrument and feel.
export const STARTERS: Starter[] = [
  {
    id: "soul",
    name: "Late-night soul",
    feels: "Smooth, slow, a little jazzy",
    bpm: 72,
    instrument: "epiano",
    style: "sustain",
    text: `title: Untitled
tempo: 72

[Verse]
Dm7  G7  Cmaj7  Am7

[Chorus]
Fmaj7  Em7  Dm7  G7

structure: Verse x2, Chorus, Verse, Chorus x2`,
  },
  {
    id: "aaina",
    name: "Heartfelt ballad",
    feels: "Slow and emotional, the Aaina feel",
    bpm: 80,
    instrument: "piano",
    style: "ballad",
    text: `title: Aaina
tempo: 80

[Mukhda]
Am  Fmaj7  C  G

[Pre-chorus]
Dm7  Am  F  E7

[Instrumental]
Am  Fmaj7  Dm7  E7

[Antara 1]
Am  Em  Fmaj7  G

[Antara 2]
F  G  Am  E7

[Outro]
Am  Fmaj7  Am(2)

structure: Mukhda x2, Pre-chorus, Mukhda x2, Instrumental, Antara 1 x2, Antara 2 x2, Pre-chorus, Mukhda x2, Outro`,
  },
  {
    id: "romance",
    name: "Bollywood romance",
    feels: "Sweet and dreamy, made for love songs",
    bpm: 88,
    instrument: "nylon",
    style: "arpeggio",
    text: `title: Untitled
tempo: 88

[Mukhda]
C  Em  Am  F

[Antara]
F  G  Em  Am
F  G  C(2)

structure: Mukhda x2, Antara, Mukhda, Antara, Mukhda x2`,
  },
  {
    id: "campfire",
    name: "Campfire acoustic",
    feels: "Warm guitar strumming, sing-along",
    bpm: 100,
    instrument: "guitar",
    style: "strum",
    text: `title: Untitled
tempo: 100

[Verse]
G  D  Em  C

[Chorus]
C  G  D  Em
C  G  D(2)

structure: Verse x2, Chorus, Verse, Chorus x2`,
  },
  {
    id: "pop",
    name: "Pop anthem",
    feels: "Big and catchy, the four chords of pop",
    bpm: 112,
    instrument: "piano",
    style: "pulse",
    text: `title: Untitled
tempo: 112

[Verse]
C  G  Am  F

[Chorus]
F  G  C  Am
F  G  C(2)

structure: Verse x2, Chorus, Verse, Chorus x2`,
  },
  {
    id: "dance",
    name: "Feel-good dance",
    feels: "Bright, bouncy, makes you move",
    bpm: 122,
    instrument: "synth",
    style: "pulse",
    text: `title: Untitled
tempo: 122

[Verse]
Fmaj7  G  Em  Am

[Chorus]
Fmaj7  G  Am  Am
Fmaj7  G  C  E7

structure: Verse x2, Chorus x2, Verse, Chorus x2`,
  },
];

/** Flame colour by tempo: yellow (slow) → orange → red → blue → teal-green (fast). */
export function flame(bpm: number): string {
  if (bpm < 76) return "#FFC21A";
  if (bpm < 85) return "#FF9A1F";
  if (bpm < 95) return "#FF5A36";
  if (bpm < 106) return "#E0407A";
  if (bpm < 116) return "#4F7CFF";
  return "#2FD3B4";
}

// Kept for the "Paste / upload" quick-load chips.
export const PRESETS = STARTERS.map((s) => ({ name: s.name, text: s.text }));
