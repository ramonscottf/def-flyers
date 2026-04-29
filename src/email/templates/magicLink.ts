// Inline-styled magic link email. Plain HTML — no React Email yet, that's
// a Phase 2 polish. Keep wording short, clear, and accessible.

export interface MagicLinkEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderMagicLinkEmail(opts: {
  url: string;
  ttlMinutes: number;
}): MagicLinkEmail {
  const { url, ttlMinutes } = opts;
  const subject = 'Sign in to DEF Flyers';
  const text = `Sign in to DEF Flyers\n\nClick the link below to sign in. The link expires in ${ttlMinutes} minutes and can only be used once.\n\n${url}\n\nIf you didn't request this, you can safely ignore this email.\n\n— Davis Education Foundation\nflyers.daviskids.org`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#0d1b3d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;max-width:560px;width:100%;">
        <tr>
          <td style="padding:32px 32px 16px;border-bottom:4px solid #0d1b3d;">
            <p style="margin:0;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#c9a13b;font-weight:600;">Davis Education Foundation</p>
            <h1 style="margin:6px 0 0;font-size:24px;color:#0d1b3d;font-weight:800;letter-spacing:-0.01em;">DEF Flyers</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px;">
            <h2 style="margin:0 0 12px;font-size:20px;color:#0d1b3d;">Sign in to submit a flyer</h2>
            <p style="margin:0 0 20px;font-size:16px;line-height:1.55;color:#4a5876;">Click the button below to sign in. The link expires in ${ttlMinutes} minutes and can only be used once.</p>
            <p style="margin:0 0 24px;">
              <a href="${url}" style="display:inline-block;background:#0d1b3d;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">Sign in to DEF Flyers</a>
            </p>
            <p style="margin:0 0 12px;font-size:14px;color:#4a5876;">Or paste this URL into your browser:</p>
            <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#1a2a5e;"><a href="${url}" style="color:#1a2a5e;">${url}</a></p>
            <p style="margin:0;font-size:13px;color:#4a5876;">If you didn't request this, you can safely ignore this email.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px;border-top:1px solid #d8dde7;">
            <p style="margin:0;font-size:12px;color:#4a5876;">Davis Education Foundation · 70 East 100 North, Farmington UT · <a href="https://daviskids.org" style="color:#1a2a5e;">daviskids.org</a></p>
            <p style="margin:6px 0 0;font-size:12px;color:#4a5876;">In partnership with Davis School District</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}
