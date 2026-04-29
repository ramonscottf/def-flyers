import type { Bindings } from '../index';

export interface EmailSender {
  send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    tag?: string;
  }): Promise<{ id: string }>;
}

// Resend transactional sender — magic links, receipts, reviewer notices.
// Phase 3+ bulk parent digests will swap in an SES implementation behind
// this same interface.
export class ResendSender implements EmailSender {
  constructor(
    private apiKey: string,
    private from: string,
    private replyTo?: string,
  ) {}

  async send({
    to,
    subject,
    html,
    text,
    tag,
  }: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    tag?: string;
  }): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      from: this.from,
      to,
      subject,
      html,
    };
    if (text) body.text = text;
    if (this.replyTo) body.reply_to = this.replyTo;
    if (tag) body.tags = [{ name: 'tag', value: tag }];

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`resend_error: ${r.status} ${err}`);
    }
    const data = (await r.json()) as { id: string };
    return { id: data.id };
  }
}

export function getTransactionalSender(env: Bindings): EmailSender {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  return new ResendSender(
    env.RESEND_API_KEY,
    'flyers@daviskids.org',
    'info@daviskids.org',
  );
}
