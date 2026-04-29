// Verification email sent on parent opt-in. Inline-styled, EN/ES.

export interface ParentVerifyEmail {
  subject: string;
  html: string;
  text: string;
}

const T = {
  en: {
    subject: 'Confirm your DEF Flyers subscription',
    eyebrow: 'Davis Education Foundation',
    title: 'Confirm your subscription',
    intro: 'Click the button below to confirm you want to receive DEF Flyers email updates. This link expires in 24 hours.',
    cta: 'Confirm subscription',
    fallback: 'Or paste this URL into your browser:',
    foot: 'You received this because someone (probably you) signed up at flyers.daviskids.org. If that wasn\'t you, you can safely ignore this email.',
  },
  es: {
    subject: 'Confirme su suscripción a DEF Flyers',
    eyebrow: 'Fundación Educativa de Davis',
    title: 'Confirme su suscripción',
    intro: 'Haga clic en el botón a continuación para confirmar que desea recibir actualizaciones por correo electrónico de DEF Flyers. Este enlace expira en 24 horas.',
    cta: 'Confirmar suscripción',
    fallback: 'O pegue esta URL en su navegador:',
    foot: 'Recibió esto porque alguien (probablemente usted) se inscribió en flyers.daviskids.org. Si no fue usted, puede ignorar este correo electrónico.',
  },
} as const;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderParentVerifyEmail(opts: {
  url: string;
  language: 'en' | 'es';
}): ParentVerifyEmail {
  const t = T[opts.language];
  const text = `${t.title}\n\n${t.intro}\n\n${opts.url}\n\n${t.foot}`;
  const html = `<!DOCTYPE html><html lang="${opts.language}"><head><meta charset="UTF-8"><title>${escapeHtml(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#0d1b3d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;max-width:560px;width:100%;">
    <tr><td style="padding:32px 32px 16px;border-bottom:4px solid #0d1b3d;">
      <p style="margin:0;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#c9a13b;font-weight:600;">${escapeHtml(t.eyebrow)}</p>
      <h1 style="margin:6px 0 0;font-size:24px;color:#0d1b3d;font-weight:800;">DEF Flyers</h1>
    </td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;font-size:20px;color:#0d1b3d;">${escapeHtml(t.title)}</h2>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.55;color:#4a5876;">${escapeHtml(t.intro)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(opts.url)}" style="display:inline-block;background:#0d1b3d;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(t.cta)}</a>
      </p>
      <p style="margin:0 0 6px;font-size:13px;color:#4a5876;">${escapeHtml(t.fallback)}</p>
      <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#1a2a5e;"><a href="${escapeHtml(opts.url)}" style="color:#1a2a5e;">${escapeHtml(opts.url)}</a></p>
      <p style="margin:0;font-size:13px;color:#4a5876;">${escapeHtml(t.foot)}</p>
    </td></tr>
    <tr><td style="padding:18px 32px 28px;border-top:1px solid #d8dde7;font-size:12px;color:#4a5876;">
      Davis Education Foundation · <a href="https://daviskids.org" style="color:#1a2a5e;">daviskids.org</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  return { subject: t.subject, html, text };
}
