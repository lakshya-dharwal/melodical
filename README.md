# Melodical (web POC)

Type or upload a chord map, choose an instrument and a feel, and hear the full instrumental in the browser. You can export it as a WAV to sing over.

```bash
npm install && npm run dev   # http://localhost:5180
```

## Chord map format

```
title: Pehle Bhi Main
tempo: 80

[Mukhda]
Am  Fmaj7  C  G        one bar each
Am(2)  G(1/2)  F(1/2)  (n) = bars, fractions ok
%                      repeat last chord
N.C.                   silence

structure: Mukhda x2, Pre-chorus, Mukhda, Antara 1
```

JSON works too: `{ "tempo": 80, "sections": [{ "name": "Mukhda", "chords": ["Am", {"chord": "G", "bars": 2}] }], "structure": ["Mukhda x2"] }`.

## How it works

- `src/song.ts`: parses the chord map and lays out the structure on a beat timeline.
- `src/theory.ts`: turns chord symbols into pitches with [tonal](https://github.com/tonaljs/tonal). It builds close voicings for keys, open shapes for guitar, and bass notes.
- `src/engine.ts`: an eighth-note pattern generator (ballad, fingerpick, strum, sustain, pulse) plus bass and synthesized drums. A lookahead scheduler plays it live. The same generator renders offline to WAV.
- Instruments are real samples via [smplr](https://github.com/danigb/smplr) (Splendid Grand Piano, MusyngKite soundfonts). They stream from public CDNs the first time you pick them. The built-in synth works offline.

No API keys or backend needed.
