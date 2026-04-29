// Landing page for flyers.daviskids.org
// Skippy rule: no entrance animations. Heroes stay still. No Squarespace energy.

export function renderLanding(stats: { schools: number; depts: number; flyers: number }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DEF Flyers — Davis Education Foundation</title>
<meta name="description" content="Community flyers and announcements for Davis School District families and employees, from the Davis Education Foundation.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📬</text></svg>">
<style>
  :root {
    --navy: #0d1b3d;
    --navy-2: #1a2a5e;
    --gold: #c9a13b;
    --red: #b1252f;
    --bg: #ffffff;
    --card: #f3f5f9;
    --ink: #0d1b3d;
    --ink-2: #4a5876;
    --rule: #d8dde7;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--ink);
    background: var(--bg);
    line-height: 1.55;
  }
  a { color: var(--navy-2); text-underline-offset: 2px; }
  a:hover, a:focus { color: var(--red); }
  .skip-link {
    position: absolute; top: -40px; left: 0;
    background: var(--navy); color: #fff; padding: 8px 16px;
    z-index: 100;
  }
  .skip-link:focus { top: 0; }

  /* ─── Hero (no animations, words only, navy) ─── */
  header.hero {
    background: var(--navy);
    color: #fff;
    padding: 56px 24px 64px;
    border-bottom: 6px solid;
    border-image: linear-gradient(90deg, var(--navy-2), var(--red)) 1;
  }
  .hero-inner { max-width: 960px; margin: 0 auto; }
  .eyebrow {
    font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--gold); font-weight: 600; margin: 0 0 12px;
  }
  h1 {
    font-size: clamp(36px, 6vw, 56px);
    font-weight: 800; letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .lede {
    font-size: clamp(17px, 2.2vw, 20px);
    color: #d6dcec; max-width: 640px;
    margin: 0 0 24px;
  }
  .hero-meta { font-size: 14px; color: #a8b3cd; margin: 0; }

  /* ─── Main ─── */
  main { max-width: 960px; margin: 0 auto; padding: 56px 24px 80px; }
  h2 {
    font-size: 24px; margin: 0 0 16px;
    color: var(--navy);
  }

  /* ─── Stat cards ─── */
  .stats {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 12px; margin: 0 0 48px;
  }
  @media (max-width: 600px) { .stats { grid-template-columns: 1fr; } }
  .stat {
    background: var(--card);
    border-radius: 10px;
    padding: 20px 24px;
  }
  .stat-num {
    font-size: 32px; font-weight: 800;
    color: var(--navy); display: block;
    line-height: 1;
  }
  .stat-label {
    font-size: 13px; color: var(--ink-2);
    margin-top: 6px; display: block;
  }

  /* ─── Two columns: parents / submitters ─── */
  .grid {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 24px; margin: 0 0 48px;
  }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--card);
    border-radius: 12px;
    padding: 28px;
  }
  .card h3 {
    margin: 0 0 8px; font-size: 20px; color: var(--navy);
  }
  .card p { margin: 0 0 16px; color: var(--ink-2); }
  .btn {
    display: inline-block;
    background: var(--navy); color: #fff;
    padding: 10px 20px; border-radius: 8px;
    text-decoration: none; font-weight: 600;
    font-size: 15px;
  }
  .btn:hover, .btn:focus {
    background: var(--red); color: #fff;
  }
  .btn.ghost {
    background: transparent; color: var(--navy);
    border: 2px solid var(--navy);
  }
  .btn.ghost:hover, .btn.ghost:focus {
    background: var(--navy); color: #fff;
  }

  /* ─── Status strip ─── */
  .status {
    background: #fff8e1;
    border: 1px solid #f0d97a;
    border-radius: 8px;
    padding: 14px 18px;
    font-size: 14px;
    margin: 0 0 32px;
    color: #5a4400;
  }
  .status strong { color: #3d2e00; }

  footer {
    border-top: 1px solid var(--rule);
    padding: 32px 24px;
    color: var(--ink-2);
    font-size: 13px;
    text-align: center;
  }
  footer a { color: var(--navy-2); }
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>

<header class="hero">
  <div class="hero-inner">
    <p class="eyebrow">Davis Education Foundation</p>
    <h1>DEF Flyers</h1>
    <p class="lede">Community flyers and district announcements for Davis School District families and employees — accessible, translated, opt-in.</p>
    <p class="hero-meta">In partnership with Davis School District · WCAG 2.1 AA · English &amp; Español</p>
  </div>
</header>

<main id="main">
  <div class="status">
    <strong>Status:</strong> Platform under active build. Submission opens to local nonprofits in pilot soon. Questions: <a href="mailto:info@daviskids.org">info@daviskids.org</a>
  </div>

  <section aria-labelledby="stats-h">
    <h2 id="stats-h">Currently in the system</h2>
    <div class="stats">
      <div class="stat">
        <span class="stat-num">${stats.schools}</span>
        <span class="stat-label">Davis SD schools indexed</span>
      </div>
      <div class="stat">
        <span class="stat-num">${stats.depts}</span>
        <span class="stat-label">District departments</span>
      </div>
      <div class="stat">
        <span class="stat-num">${stats.flyers}</span>
        <span class="stat-label">Published flyers</span>
      </div>
    </div>
  </section>

  <section aria-labelledby="who-h">
    <h2 id="who-h">Who this is for</h2>
    <div class="grid">
      <div class="card">
        <h3>Parents &amp; families</h3>
        <p>Get the flyers that matter for your kids' schools. Pick which schools, languages, and topics. Unsubscribe anytime.</p>
        <a class="btn" href="/parent">Sign up for flyers</a>
      </div>
      <div class="card">
        <h3>Community organizations</h3>
        <p>Submit a flyer to reach Davis families directly. Local nonprofits free. Standard rates well below Peachjar.</p>
        <a class="btn ghost" href="/submit">Submit a flyer</a>
      </div>
    </div>
  </section>

  <section aria-labelledby="diff-h">
    <h2 id="diff-h">Why DEF Flyers</h2>
    <p>Every flyer is reviewed by a real person. Every flyer is rebuilt as accessible HTML with proper alt text, structured headings, and a Spanish translation. Every parent picks what they want to see — and can opt out in one click. The Foundation owns the channel, end-to-end, in Davis County.</p>
  </section>
</main>

<footer>
  <p>Davis Education Foundation · 70 East 100 North, Farmington UT · <a href="https://daviskids.org">daviskids.org</a></p>
  <p><a href="/policies/privacy">Privacy</a> · <a href="/policies/accessibility">Accessibility</a> · <a href="/policies/tcpa">SMS Terms</a></p>
</footer>

</body>
</html>`;
}
