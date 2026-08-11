/** Scales, chords and the genre config bundle. v1 ships Cinematic only. */

export const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export const SCALES: Record<string, number[]> = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export const QUAL: Record<string, number[]> = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dom7: [0, 4, 7, 10],
  min9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
};

export type VoicingStyle = "close" | "open" | "spread" | "rootless" | "quartal";

export interface Genre {
  id: string;
  name: string;
  accent: string;
  /** rgb 0..1 used to tint the stage visuals */
  grade: [number, number, number];
  tonic: number;
  scale: keyof typeof SCALES | string;
  bpm: number;
  swing: number;
  barsPerChord: number;
  /** [semitones above tonic, quality] */
  prog: Array<[number, string]>;
  voicing: VoicingStyle;
  pad: number;
  bassOct: number;
  melOct: number;
  sustain: number;
  reverb: number;
  ornament: number;
}

export const CINEMATIC: Genre = {
  id: "cinematic",
  name: "Cinematic",
  accent: "#7FB2E5",
  grade: [0.42, 0.6, 0.9],
  tonic: 0,
  scale: "aeolian",
  bpm: 74,
  swing: 0,
  barsPerChord: 2,
  prog: [
    [0, "min"], [8, "maj"], [3, "maj"], [10, "maj"],
    [0, "min"], [5, "min"], [8, "maj"], [7, "sus4"],
  ],
  voicing: "open",
  pad: 0.55,
  bassOct: 2,
  melOct: 5,
  sustain: 0.9,
  reverb: 0.52,
  ornament: 0.3,
};

export const GENRES: Genre[] = [CINEMATIC];

export function noteLabel(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
