import { Hono } from 'hono';
import type { Bindings } from '../index';

const api = new Hono<{ Bindings: Bindings }>();

// Phase 1 build target — submitter portal:
//   POST /magic-link        → email a magic link
//   POST /verify            → exchange token for session cookie
//   POST /submit            → create draft flyer (structured fields)
//   POST /submit/upload-url → presigned R2 PUT for supplemental PDF/image
//   GET  /flyer/:id         → submitter's own flyer
//   POST /flyer/:id/finalize→ enqueue to AI pipeline + payment
//
// All routes below are stubs returning 501 so the surface area is documented.

api.post('/magic-link', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/verify', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/submit', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/submit/upload-url', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.get('/flyer/:id', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/flyer/:id/finalize', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));

export default api;
