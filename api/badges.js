import { put, del, list } from '@vercel/blob';

// One immutable blob per badge (badges/<id>.json). The Blob CDN caches file
// content aggressively, so files must never be rewritten — list() metadata is
// always fresh, and immutable content makes the cache correct by construction.
const PREFIX = 'badges/';

async function readBadges() {
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  const results = await Promise.all(
    blobs.map(async (b) => {
      try {
        const res = await fetch(b.url);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    })
  );
  return results
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

const clean = (s, max = 200) => String(s ?? '').slice(0, max).trim();
const SAFE_ID = /^[0-9]+-[a-z0-9]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ badges: await readBadges() });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const name = clean(b.name);
      const org = clean(b.org);
      const linkedin = clean(b.linkedin);
      if (!name || !org || !linkedin) {
        return res.status(400).json({ error: 'name, org and linkedin are required' });
      }
      const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
      if (blobs.length >= 500) {
        return res.status(429).json({ error: 'the wall is full for now' });
      }
      const roadmap = (Array.isArray(b.roadmap) ? b.roadmap : [])
        .slice(0, 8)
        .map((r) => ({
          role: clean(r?.role, 40),
          org: clean(r?.org, 80),
          year: clean(r?.year, 4),
        }))
        .filter((r) => r.role || r.org || r.year);
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        org,
        linkedin,
        event: clean(b.event) || 'GSoC Alumni',
        city: clean(b.city) || '—',
        year: clean(b.year, 4) || String(new Date().getFullYear()),
        role: clean(b.role, 40) || 'Attendee',
        roadmap,
        createdAt: new Date().toISOString(),
      };
      await put(`${PREFIX}${entry.id}.json`, JSON.stringify(entry), {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'application/json',
        cacheControlMaxAge: 31536000,
      });
      return res.status(201).json({ badge: entry });
    }

    if (req.method === 'DELETE') {
      const id = clean(req.query.id, 60);
      if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'valid id required' });
      await del(`${PREFIX}${id}.json`);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
}
