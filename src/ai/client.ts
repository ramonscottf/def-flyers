// Anthropic Messages API client. Provider abstraction kept thin — when we
// need to swap to Workers AI for a step, the same shape applies.

import type { Bindings } from '../index';

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface AnthropicDocumentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicCallOptions {
  model: string;
  system: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
}

export interface AnthropicResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
  raw: unknown;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured');
  }
}

export async function callAnthropic(
  env: Bindings,
  opts: AnthropicCallOptions,
): Promise<AnthropicResponse> {
  if (!env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature ?? 0,
    }),
  });

  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`anthropic_error ${r.status}: ${detail}`);
  }

  const data = (await r.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
  };

  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  return {
    text,
    usage: data.usage,
    stop_reason: data.stop_reason,
    raw: data,
  };
}

export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_HAIKU = 'claude-haiku-4-5';

// Rough cost per 1K tokens. Used only for cost-budget warnings.
const PRICING = {
  [MODEL_SONNET]: { input: 0.003, output: 0.015 },
  [MODEL_HAIKU]: { input: 0.001, output: 0.005 },
} as const;

export function estimateCostUsd(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const p = (PRICING as Record<string, { input: number; output: number }>)[model];
  if (!p) return 0;
  return (usage.input_tokens / 1000) * p.input + (usage.output_tokens / 1000) * p.output;
}

// Strip markdown code fences if the model wraps JSON despite our instructions.
export function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return text.trim();
}
