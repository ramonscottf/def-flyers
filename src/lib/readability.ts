// Flesch–Kincaid Grade Level on plain text. Heuristics, not a perfect
// linguistic model — good enough to flag flyers written above grade 8 so
// the reviewer/submitter can simplify.

export interface ReadabilityResult {
  word_count: number;
  sentence_count: number;
  syllable_count: number;
  reading_level: number; // FK grade
}

export function analyze(text: string): ReadabilityResult {
  if (!text || !text.trim()) {
    return { word_count: 0, sentence_count: 0, syllable_count: 0, reading_level: 0 };
  }

  const words = text
    .replace(/[\r\n]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ''))
    .filter((w) => w.length > 0);

  const wordCount = words.length;
  if (wordCount === 0) {
    return { word_count: 0, sentence_count: 0, syllable_count: 0, reading_level: 0 };
  }

  const sentenceMatches = text.match(/[^.!?\n]+[.!?]+/g);
  const sentenceCount = Math.max(1, sentenceMatches?.length ?? 1);

  let syllableCount = 0;
  for (const w of words) syllableCount += countSyllables(w);

  // FK grade = 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
  const grade =
    0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59;

  return {
    word_count: wordCount,
    sentence_count: sentenceCount,
    syllable_count: syllableCount,
    // Round to 1 decimal, clamp to a sane band.
    reading_level: Math.max(0, Math.round(grade * 10) / 10),
  };
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;

  // Strip silent trailing 'e', handle 'le' ending.
  let stripped = w;
  if (stripped.endsWith('e') && !stripped.endsWith('le')) {
    stripped = stripped.slice(0, -1);
  }

  const groups = stripped.match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}
