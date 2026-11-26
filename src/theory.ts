// Chord symbol -> pitches. Small, deterministic voicing rules; no ML needed for playback.
import { Chord, Interval, Note } from "tonal";
import { isRest, type Song } from "./song";

export type ParsedChord = {
  root: number; // pitch class 0-11
  bass: number; // pitch class of the lowest note (slash chords)
  offsets: number[]; // unique semitone offsets from root, mod 12, in chord order
};

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const cache = new Map<string, ParsedChord | null>();

export function parseChord(symbol: string): ParsedChord | null {
  if (cache.has(symbol)) return cache.get(symbol)!;
  let result: ParsedChord | null = null;
  if (!isRest(symbol)) {
    const [main, slash] = symbol.split("/");
    const c = Chord.get(main);
    if (!c.empty && c.tonic) {
      const root = Note.chroma(c.tonic)!;
      const offsets: number[] = [];
      for (const iv of c.intervals) {
        const s = (((Interval.semitones(iv) ?? 0) % 12) + 12) % 12;
        if (!offsets.includes(s)) offsets.push(s);
      }
      const bassPc = slash ? Note.chroma(slash) : undefined;
      result = { root, bass: bassPc ?? root, offsets };
    }
  }
  cache.set(symbol, result);
  return result;
}

export function transposeSymbol(symbol: string, semis: number): string {
  if (!semis || isRest(symbol)) return symbol;
  const m = symbol.match(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!m) return symbol;
  const shift = (n: string) => NAMES[(((Note.chroma(n) ?? 0) + semis) % 12 + 12) % 12];
  return shift(m[1]) + m[2] + (m[3] ? "/" + shift(m[3]) : "");
}

export function transposeSong(song: Song, semis: number): Song {
  if (!semis) return song;
  return {
    ...song,
    sections: song.sections.map((s) => ({
      ...s,
      chords: s.chords.map((c) => ({ ...c, symbol: transposeSymbol(c.symbol, semis) })),
    })),
  };
}

const lowestAtOrAbove = (pc: number, floor: number) => floor + ((pc - floor) % 12 + 12) % 12;

/** Close voicing for keys/pads, choosing the inversion that sits nearest middle C-ish. */
export function keysVoicing(ch: ParsedChord): number[] {
  let offs = ch.offsets;
  if (offs.length >= 5) offs = offs.filter((o) => o !== 7); // thin out big extensions
  const pcs = offs.map((o) => (ch.root + o) % 12);
  let best: number[] = [];
  let bestScore = Infinity;
  for (let r = 0; r < pcs.length; r++) {
    const order = [...pcs.slice(r), ...pcs.slice(0, r)];
    const notes: number[] = [];
    let floor = 53;
    for (const pc of order) {
      const n = lowestAtOrAbove(pc, floor);
      notes.push(n);
      floor = n + 1;
    }
    const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
    const score = Math.abs(mean - 64) + (notes[notes.length - 1] > 77 ? 10 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = notes;
    }
  }
  return best;
}

/** Open, guitar-shaped voicing: low bass string, then fifth/root/third stacked with string-like gaps. */
export function guitarVoicing(ch: ParsedChord): number[] {
  const low = lowestAtOrAbove(ch.bass, 40); // E2..D#3
  const third = ch.offsets.find((o) => o === 3 || o === 4 || o === 2 || o === 5);
  const fifth = ch.offsets.find((o) => o === 7 || o === 6 || o === 8);
  const color = ch.offsets.filter((o) => o !== 0 && o !== third && o !== fifth);
  const order = [fifth ?? 0, 0, third ?? 0, ...color, fifth ?? 0, 0].filter((o) => o !== undefined) as number[];
  const notes = [low];
  for (const o of order) {
    if (notes.length >= 6) break;
    const n = lowestAtOrAbove((ch.root + o) % 12, notes[notes.length - 1] + 3);
    if (n > 71) break;
    notes.push(n);
  }
  return notes;
}

export function bassNote(ch: ParsedChord): number {
  return lowestAtOrAbove(ch.bass, 33); // A1..G#2
}

export function fifthAbove(ch: ParsedChord): number {
  const f = ch.offsets.find((o) => o === 7 || o === 6 || o === 8) ?? 0;
  return lowestAtOrAbove((ch.root + f) % 12, 33);
}

export function pcName(pc: number) {
  return NAMES[pc];
}
