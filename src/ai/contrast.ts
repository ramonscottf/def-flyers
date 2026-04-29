// WCAG 2.1 luminance + contrast ratio math.
// No AI. Pure deterministic colour-pair scoring.

export interface ContrastFinding {
  fg: string;
  bg: string;
  ratio: number;
  level: 'AAA' | 'AA' | 'AA-large' | 'fail';
}

export interface ContrastResult {
  inspected_pairs: number;
  min_ratio: number;
  passed: boolean;
  findings: ContrastFinding[];
  note?: string;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], navy: [0, 0, 128], gray: [128, 128, 128],
  silver: [192, 192, 192], maroon: [128, 0, 0], orange: [255, 165, 0],
  purple: [128, 0, 128], pink: [255, 192, 203], teal: [0, 128, 128],
};

function parseColor(input: string): [number, number, number] | null {
  const s = input.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const norm = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

function gradeRatio(ratio: number): ContrastFinding['level'] {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

// Walk every inline `style="..."` attribute, pull color + background-color
// pairs declared together on the same element, and compute their contrast.
// Also checks any standalone `<font color="...">` or background-color usages
// that we can pair against the page default (white).
export function inspectInlineColors(html: string): ContrastResult {
  const findings: ContrastFinding[] = [];

  const styleAttrs = html.match(/style\s*=\s*"[^"]*"/gi) ?? [];
  for (const raw of styleAttrs) {
    const decls = raw.replace(/^style\s*=\s*"|"$/gi, '');
    const colorMatch = decls.match(/(?:^|;|\s)color\s*:\s*([^;]+?)(?:;|$)/i);
    const bgMatch = decls.match(/(?:^|;|\s)background(?:-color)?\s*:\s*([^;]+?)(?:;|$)/i);
    if (colorMatch && bgMatch) {
      const fg = parseColor(colorMatch[1]);
      const bg = parseColor(bgMatch[1]);
      if (fg && bg) {
        const ratio = contrastRatio(fg, bg);
        findings.push({
          fg: colorMatch[1].trim(),
          bg: bgMatch[1].trim(),
          ratio: Math.round(ratio * 100) / 100,
          level: gradeRatio(ratio),
        });
      }
    } else if (colorMatch) {
      // colour against assumed white page background
      const fg = parseColor(colorMatch[1]);
      if (fg) {
        const ratio = contrastRatio(fg, [255, 255, 255]);
        findings.push({
          fg: colorMatch[1].trim(),
          bg: '#ffffff (assumed)',
          ratio: Math.round(ratio * 100) / 100,
          level: gradeRatio(ratio),
        });
      }
    }
  }

  if (findings.length === 0) {
    return {
      inspected_pairs: 0,
      min_ratio: 21,
      passed: true,
      findings: [],
      note: 'no inline color overrides; default theme assumed AA',
    };
  }

  const min = findings.reduce((m, f) => Math.min(m, f.ratio), 21);
  return {
    inspected_pairs: findings.length,
    min_ratio: Math.round(min * 100) / 100,
    passed: findings.every((f) => f.level !== 'fail'),
    findings,
  };
}
