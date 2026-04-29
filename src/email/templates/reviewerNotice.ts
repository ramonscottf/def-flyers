// Notices the reviewer sends to the submitter on reject / request-changes.

export interface ReviewerNoticeEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderRejectEmail(opts: {
  flyerTitle: string;
  reason: string;
  baseUrl: string;
}): ReviewerNoticeEmail {
  const subject = `Update on your DEF Flyers submission: "${opts.flyerTitle}"`;
  const text = `Your flyer "${opts.flyerTitle}" was not approved for distribution.\n\nReason from the reviewer:\n${opts.reason}\n\nYou can submit a revised flyer at ${opts.baseUrl}/submit.\n\n— Davis Education Foundation`;
  const html = wrap({
    heading: 'Your flyer was not approved',
    body: `<p>Your flyer <strong>${escapeHtml(opts.flyerTitle)}</strong> was not approved for distribution at this time.</p>
      <p style="margin:16px 0 8px;font-weight:600;color:#0d1b3d;">Reason from the reviewer:</p>
      <blockquote style="margin:0 0 16px;padding:12px 16px;background:#fbeaea;border-left:4px solid #b1252f;border-radius:6px;color:#6b1c22;">${escapeHtml(opts.reason)}</blockquote>
      <p>You're welcome to revise and re-submit.</p>
      <p><a href="${opts.baseUrl}/submit" style="display:inline-block;background:#0d1b3d;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Submit a new flyer</a></p>`,
  });
  return { subject, html, text };
}

export function renderRequestChangesEmail(opts: {
  flyerTitle: string;
  notes: string;
  baseUrl: string;
  flyerId: string;
}): ReviewerNoticeEmail {
  const subject = `Changes requested on your DEF Flyers submission: "${opts.flyerTitle}"`;
  const text = `The reviewer has requested changes to "${opts.flyerTitle}" before it can be approved.\n\nNotes from the reviewer:\n${opts.notes}\n\nYour flyer is back in draft. Make the changes and re-submit at ${opts.baseUrl}/submit.\n\n— Davis Education Foundation`;
  const html = wrap({
    heading: 'Changes requested',
    body: `<p>The reviewer has asked for changes on your flyer <strong>${escapeHtml(opts.flyerTitle)}</strong> before it can go out.</p>
      <p style="margin:16px 0 8px;font-weight:600;color:#0d1b3d;">Notes from the reviewer:</p>
      <blockquote style="margin:0 0 16px;padding:12px 16px;background:#fff8e1;border-left:4px solid #c9a13b;border-radius:6px;color:#5a4400;">${escapeHtml(opts.notes)}</blockquote>
      <p>Your flyer is back in draft. Apply the changes and re-submit when you're ready.</p>
      <p><a href="${opts.baseUrl}/submit" style="display:inline-block;background:#0d1b3d;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open my flyers</a></p>`,
  });
  return { subject, html, text };
}

export function renderApprovalEmail(opts: {
  flyerTitle: string;
  scheduled: boolean;
  scheduledFor?: number;
}): ReviewerNoticeEmail {
  const date = opts.scheduledFor
    ? new Date(opts.scheduledFor * 1000).toLocaleString('en-US', { timeZone: 'America/Denver' })
    : 'shortly';
  const subject = opts.scheduled
    ? `Your flyer is scheduled: "${opts.flyerTitle}"`
    : `Your flyer was approved: "${opts.flyerTitle}"`;
  const verb = opts.scheduled
    ? `Your flyer will be sent on ${date} (Mountain Time).`
    : `Your flyer is approved and will be sent shortly.`;
  const text = `${verb}\n\nThank you for using DEF Flyers.\n\n— Davis Education Foundation`;
  const html = wrap({
    heading: opts.scheduled ? 'Your flyer is scheduled' : 'Your flyer was approved',
    body: `<p><strong>${escapeHtml(opts.flyerTitle)}</strong></p>
      <p>${escapeHtml(verb)}</p>
      <p>Thank you for using DEF Flyers.</p>`,
  });
  return { subject, html, text };
}

function wrap(opts: { heading: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#0d1b3d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;max-width:560px;width:100%;">
    <tr><td style="padding:32px 32px 16px;border-bottom:4px solid #0d1b3d;">
      <p style="margin:0;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#c9a13b;font-weight:600;">Davis Education Foundation</p>
      <h1 style="margin:6px 0 0;font-size:22px;color:#0d1b3d;font-weight:800;">${escapeHtml(opts.heading)}</h1>
    </td></tr>
    <tr><td style="padding:24px 32px;font-size:15px;line-height:1.55;color:#4a5876;">${opts.body}</td></tr>
    <tr><td style="padding:16px 32px 28px;border-top:1px solid #d8dde7;font-size:12px;color:#4a5876;">
      Davis Education Foundation · <a href="https://daviskids.org" style="color:#1a2a5e;">daviskids.org</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
