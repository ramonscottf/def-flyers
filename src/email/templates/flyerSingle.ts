// Single-flyer email — what subscribers receive when one flyer publishes.
// Inline-styled; no external assets except the flyer image (if any).

export interface FlyerSingleEmailInput {
  title: string;
  summary: string;
  bodyHtml: string;
  flyerUrl: string;
  unsubscribeUrl: string;
  imageUrl: string | null;
  imageAlt: string | null;
  language: 'en' | 'es';
  eventLine: string | null;
  expires: string;
  baseUrl: string;
}

const T = {
  en: {
    eyebrow: 'Davis Education Foundation',
    viewOnline: 'View this flyer online',
    expiresLabel: 'Expires',
    unsubLabel: 'Manage email preferences or unsubscribe',
    footer: 'You received this because you opted in to flyers from Davis Education Foundation in partnership with Davis School District.',
  },
  es: {
    eyebrow: 'Fundación Educativa de Davis',
    viewOnline: 'Ver este folleto en línea',
    expiresLabel: 'Vence',
    unsubLabel: 'Administrar preferencias o cancelar suscripción',
    footer: 'Usted recibió esto porque se inscribió para recibir folletos de Davis Education Foundation en colaboración con Davis School District.',
  },
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderFlyerSingleEmail(input: FlyerSingleEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const t = T[input.language];
  const subject = input.title;

  const heroImage = input.imageUrl
    ? `<tr><td style="padding:0 0 16px;"><img src="${escapeHtml(input.imageUrl)}" alt="${escapeHtml(input.imageAlt ?? '')}" width="496" style="width:100%;max-width:496px;height:auto;border-radius:8px;display:block;"></td></tr>`
    : '';

  const eventLine = input.eventLine
    ? `<p style="margin:0 0 12px;color:#0d1b3d;font-size:15px;font-weight:600;">${escapeHtml(input.eventLine)}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="${input.language}">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#0d1b3d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;max-width:560px;width:100%;">
    <tr><td style="padding:28px 32px 0;border-bottom:4px solid #0d1b3d;">
      <p style="margin:0;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#c9a13b;font-weight:600;">${escapeHtml(t.eyebrow)}</p>
      <h1 style="margin:6px 0 16px;font-size:24px;color:#0d1b3d;font-weight:800;letter-spacing:-0.01em;">${escapeHtml(input.title)}</h1>
    </td></tr>
    <tr><td style="padding:24px 32px;">
      <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#4a5876;">${escapeHtml(input.summary)}</p>
      ${eventLine}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${heroImage}</table>
      <div style="font-size:15px;line-height:1.55;color:#0d1b3d;">${input.bodyHtml || ''}</div>
      <p style="margin:24px 0 8px;">
        <a href="${escapeHtml(input.flyerUrl)}" style="display:inline-block;background:#0d1b3d;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${escapeHtml(t.viewOnline)}</a>
      </p>
      <p style="margin:0;color:#4a5876;font-size:13px;">${escapeHtml(t.expiresLabel)}: ${escapeHtml(input.expires)}</p>
    </td></tr>
    <tr><td style="padding:18px 32px 28px;border-top:1px solid #d8dde7;font-size:12px;color:#4a5876;">
      <p style="margin:0 0 6px;">${escapeHtml(t.footer)}</p>
      <p style="margin:0;"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#1a2a5e;">${escapeHtml(t.unsubLabel)}</a></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = `${input.title}\n\n${input.summary}\n\n${input.eventLine ?? ''}\n\n${input.flyerUrl}\n\n${t.unsubLabel}: ${input.unsubscribeUrl}\n\n${t.footer}`;

  return { subject, html, text };
}
