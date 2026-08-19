// Self-hosted server for the GSoC Alumni Badge Wall (Rancher / Kubernetes).
// On Vercel each api/*.js ran as a serverless function; here one small Express
// process serves the static pages and mounts the same handlers unchanged, so
// there is a single source of truth for the API. Data still lives in Supabase.
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import badges from './api/badges.js';
import photo from './api/photo.js';
import keepalive from './api/keepalive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' })); // photos arrive as base64 JSON

// health check for container/k8s probes — no Supabase call, always cheap
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// API — each handler runs its own method switch, so mount all methods
app.all('/api/badges', (req, res) => badges(req, res));
app.all('/api/photo', (req, res) => photo(req, res));
app.all('/api/keepalive', (req, res) => keepalive(req, res));

// static assets
for (const f of ['favicon.svg', 'favicon.png', 'apple-touch-icon.png']) {
  app.get('/' + f, (_req, res) => res.sendFile(join(__dirname, f)));
}
// pages (clean URLs: /mini serves mini.html)
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get(['/mini', '/mini.html'], (_req, res) => res.sendFile(join(__dirname, 'mini.html')));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`GSoC Alumni Badge Wall listening on :${port}`));
