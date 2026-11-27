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

No API keys or backend needed. Songs and takes are saved in the browser.

## Cloud backup (optional)

Sign-in and sync use [Supabase](https://supabase.com). Without the two env vars below the app runs browser-only, exactly as before. Projects sync as rows, and takes upload as lossless FLAC into a private bucket (exports stay WAV).

1. Create a Supabase project.
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql). It creates the `projects` and `takes` tables with row-level security and the private `takes` storage bucket.
3. Under Authentication → Providers, enable **Email** (magic link) and **Google** (add your Google OAuth client ID and secret).
4. Under Authentication → URL Configuration, set the Site URL to your production URL. Add redirect URLs for it and for `http://localhost:5180`.
5. Copy `.env.example` to `.env` and fill in the project URL and the **anon** key (Project Settings → API). Never use the service-role key.
6. On Vercel, add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` environment variables, then redeploy.

Then open Settings → Cloud backup and sign in. The first sign-in uploads everything in this browser. After that, edits push in the background (queued while offline), and other devices pull changes on sign-in and when the tab regains focus. The newest edit wins.
