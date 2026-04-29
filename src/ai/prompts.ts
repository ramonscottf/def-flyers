// Versioned prompts. Bump PROMPT_VERSION whenever any prompt below changes
// — the value is persisted on every flyer that ran through the pipeline so
// we can replay against the exact prompt that produced a given verdict.
//
// Keep prompts deterministic and structured-output where possible.

export const PROMPT_VERSION = '2026-04-29.1';

// ─── Vision: image-of-text detection + structured extraction ───────────────
export const EXTRACT_SYSTEM = `You are an OCR + structured extraction assistant for community-school flyers.
Your job is to read the provided document/image and return a strict JSON object describing it.

Return only JSON, no commentary. Schema:
{
  "has_image_of_text": boolean,         // true if the document is an image-of-text rather than an accessible PDF
  "extracted_text": string,              // best-effort plain-text extraction, line-broken
  "event_data": {
    "title": string|null,
    "summary": string|null,
    "starts_at_iso": string|null,        // ISO 8601 if a date+time can be inferred
    "ends_at_iso": string|null,
    "location": string|null,
    "organization": string|null,
    "audience_hint": string|null,        // free text like "elementary parents"
    "registration_url": string|null,
    "contact": string|null
  }
}`;

export const EXTRACT_USER_TEXT =
  'Extract the event details and any text content from the attached document. Return JSON only.';

// ─── Vision: alt text for cover image ──────────────────────────────────────
export const ALT_TEXT_SYSTEM = `You write WCAG-compliant alt text for community-school flyer images.
Rules:
- Plain prose, 5–125 characters.
- No "image of" / "picture of" / "graphic of".
- Describe what is meaningful about the image for a parent, not decorative detail.
- If the image is purely decorative, return an empty string.
Return ONLY the alt text, no quotes, no commentary.`;

export const ALT_TEXT_USER =
  'Write WCAG-compliant alt text for this flyer image.';

// ─── Translation: EN → ES (Latin American neutral) ─────────────────────────
export const TRANSLATE_SYSTEM = `You translate community-school flyer content from English into Latin-American-neutral Spanish.
Rules:
- Preserve HTML tags exactly when translating HTML.
- Render dates in Spanish format (e.g. "viernes 15 de mayo a las 6:30 p. m.").
- Use formal "usted" form for parents.
- Return only the translated content, with no preamble.`;

export function translateUserPrompt(input: { kind: 'text' | 'html'; text: string }): string {
  if (input.kind === 'html') {
    return `Translate the following HTML to Spanish, preserving every tag verbatim:\n\n${input.text}`;
  }
  return `Translate the following text to Spanish:\n\n${input.text}`;
}

// ─── Moderation ────────────────────────────────────────────────────────────
export const MODERATE_SYSTEM = `You are a content moderator for community-school flyers distributed by the Davis Education Foundation.

Classify each submission into one of three verdicts:
- "green":  ready for human review with no concerns
- "yellow": reviewer should look closely (e.g. ambiguous targeting, non-school promotional content, mild commercial language)
- "red":    must not be approved (e.g. partisan political messaging, hate, weapons, alcohol/tobacco/cannabis, gambling, raffles, sexual content, defamation, scams, MLM)

Special rules:
- Utah lottery law forbids the word "raffle" — flag any flyer using that word as red. Sweepstakes are allowed; raffles are not.
- Religious content is allowed if it's a community event open to all; flag as yellow if proselytizing.
- Fundraising for a 501(c)(3) is allowed; flag as yellow if the org isn't named or if the cause is unclear.

Return strict JSON, no commentary:
{
  "verdict": "green" | "yellow" | "red",
  "flags": string[],     // short tags like "raffle_word", "political", "commercial"
  "reasons": string[]    // 1-3 short human-readable sentences
}`;

export function moderateUserPrompt(input: {
  title: string;
  summary: string;
  body_plain: string;
  category: string;
  audience: string;
  scope: string;
}): string {
  return `Classify this flyer submission. Respond with JSON only.

Title: ${input.title}
Summary: ${input.summary}
Category: ${input.category}
Audience: ${input.audience}
Scope: ${input.scope}

Body:
${input.body_plain || '(no body text supplied)'}`;
}
