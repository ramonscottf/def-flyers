import { Hono } from 'hono';
import type { Bindings } from '../index';

const api = new Hono<{ Bindings: Bindings }>();

// Phase 1 build target — admin reviewer queue (Entra ID gated):
//   GET  /queue                  → pending flyers w/ AI verdicts
//   GET  /flyer/:id              → full review surface
//   POST /flyer/:id/approve      → approve + schedule send
//   POST /flyer/:id/reject       → reject + reason
//   POST /flyer/:id/request      → request changes (back to submitter)
//   GET  /metrics                → simple admin dashboard
//   GET  /audit                  → admin audit log read

api.get('/queue', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.get('/flyer/:id', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/flyer/:id/approve', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/flyer/:id/reject', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.post('/flyer/:id/request', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.get('/metrics', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));
api.get('/audit', (c) => c.json({ error: 'not_implemented_yet', phase: 1 }, 501));

export default api;
