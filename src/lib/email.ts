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

// Postmark transactional sender — magic links, receipts, reviewer notices.
// Bulk parent digests will go through SES (added later in phase 1).
export class PostmarkSender implements EmailSender {
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
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.apiKey,
      },
      body: JSON.stringify({
        From: this.from,
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: text,
        ReplyTo: this.replyTo,
        Tag: tag,
        MessageStream: 'outbound',
        TrackOpens: false,
        TrackLinks: 'None',
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`postmark_error: ${r.status} ${err}`);
    }
    const data = (await r.json()) as { MessageID: string };
    return { id: data.MessageID };
  }
}

// Logs to console so dev/preview can exercise the flow without Postmark.
// Production should always have POSTMARK_API_KEY set.
export class ConsoleSender implements EmailSender {
  async send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    tag?: string;
  }): Promise<{ id: string }> {
    console.log('[email:console]', JSON.stringify({
      to: opts.to,
      subject: opts.subject,
      tag: opts.tag,
      preview: opts.text ?? opts.html.slice(0, 200),
    }));
    return { id: `console-${Date.now()}` };
  }
}

export function getTransactionalSender(env: Bindings): EmailSender {
  if (env.POSTMARK_API_KEY) {
    return new PostmarkSender(
      env.POSTMARK_API_KEY,
      'flyers@daviskids.org',
      'info@daviskids.org',
    );
  }
  return new ConsoleSender();
}
