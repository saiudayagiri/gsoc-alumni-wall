import { put, del, list } from '@vercel/blob';
import { createHash } from 'crypto';

// One immutable blob per badge revision (badges/<id>.<rev>.json). The Blob CDN
// caches file content ~forever, so files are never rewritten: edits write a new
// revision and delete the old file. list() metadata is the source of truth.
const PREFIX = 'badges/';
const PHOTOS = 'photos/';
const GH_REPO = 'saiudayagiri/gsoc-alumni-wall';

const clean = (s, max = 200) => String(s ?? '').slice(0, max).trim();
const SAFE_ID = /^[0-9]+-[a-z0-9]+$/;
// Emails are the edit key but are never stored or published — only this hash.
const ownerHash = (email) =>
  createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

const sanitizeRoadmap = (v) =>
  (Array.isArray(v) ? v : [])
    .slice(0, 12)
    .map((r) => ({ role: clean(r?.role, 40), org: clean(r?.org, 80), year: clean(r?.year, 4) }))
    .filter((r) => r.role || r.org || r.year);

const sanitizeSocials = (v) =>
  (Array.isArray(v) ? v : [])
    .slice(0, 10)
    .map((s) => ({ platform: clean(s?.platform, 30), url: clean(s?.url, 300) }))
    .filter((s) => s.url);

const publicView = ({ owner, ...rest }) => rest;

async function readAll() {
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  const items = await Promise.all(
    blobs.map(async (b) => {
      try {
        const r = await fetch(b.url);
        return r.ok ? { entry: await r.json(), pathname: b.pathname } : null;
      } catch {
        return null;
      }
    })
  );
  // several revisions of a badge may coexist briefly — keep the newest
  const byId = new Map();
  for (const it of items.filter(Boolean)) {
    const rev = (e) => e.updatedAt || e.createdAt || '';
    const prev = byId.get(it.entry.id);
    if (!prev || rev(it.entry) > rev(prev.entry)) byId.set(it.entry.id, it);
  }
  return [...byId.values()];
}

async function writeEntry(entry, oldPathname) {
  await put(`${PREFIX}${entry.id}.${Date.now()}.json`, JSON.stringify(entry), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    cacheControlMaxAge: 31536000,
  });
  if (oldPathname) {
    try { await del(oldPathname); } catch {}
  }
}

async function savePhoto(id, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return '';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > 500000) return '';
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const res = await put(`${PHOTOS}${id}.${Date.now()}.${ext}`, buf, {
    access: 'public',
    addRandomSuffix: false,
    contentType: `image/${m[1]}`,
    cacheControlMaxAge: 31536000,
  });
  return res.url;
}

// Best-effort mirror into the GitHub repo (data/badges/<id>.json) so the wall
// survives losing the Blob store. Stores the owner hash, never a raw email.
async function ghBackup(action, id, entry) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  const url = `https://api.github.com/repos/${GH_REPO}/contents/data/badges/${id}.json`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gsoc-alumni-wall',
    'Content-Type': 'application/json',
  };
  try {
    let sha;
    const existing = await fetch(url, { headers });
    if (existing.ok) sha = (await existing.json()).sha;
    if (action === 'save') {
      await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `backup: badge ${id} (${entry.name})`,
          content: Buffer.from(JSON.stringify(entry, null, 2)).toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
    } else if (action === 'remove' && sha) {
      await fetch(url, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ message: `backup: remove badge ${id}`, sha }),
      });
    }
  } catch (e) {
    console.error('github backup failed', e);
  }
}

function buildFields(b) {
  return {
    name: clean(b.name),
    linkedin: clean(b.linkedin),
    gsocUrl: clean(b.gsocUrl, 300),
    org: clean(b.org, 80),
    event: clean(b.event) || 'GSoC Alumni',
    city: clean(b.city, 60),
    year: clean(b.year, 4) || String(new Date().getFullYear()),
    role: clean(b.role, 40) || 'GSoCer',
    roadmap: sanitizeRoadmap(b.roadmap),
    socials: sanitizeSocials(b.socials),
  };
}

const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const all = await readAll();
      const email = clean(req.query.email, 200);
      if (email) {
        const mine = all.filter((it) => it.entry.owner && it.entry.owner === ownerHash(email));
        return res.status(200).json({ badges: mine.map((it) => publicView(it.entry)) });
      }
      return res.status(200).json({ badges: all.map((it) => publicView(it.entry)) });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const fields = buildFields(b);
      const email = clean(b.email, 200);
      if (!fields.name || !fields.linkedin || !email || !fields.gsocUrl) {
        return res.status(400).json({ error: 'name, email, linkedin and gsocUrl are required' });
      }
      if (!fields.org && fields.roadmap.length) fields.org = fields.roadmap[0].org;
      if (!fields.org) return res.status(400).json({ error: 'add at least one roadmap row with your org' });

      const all = await readAll();
      if (all.length >= 500) return res.status(429).json({ error: 'the wall is full for now' });
      // the GSoC project URL is the unique id of an alum
      if (all.some((it) => normUrl(it.entry.gsocUrl) === normUrl(fields.gsocUrl))) {
        return res.status(409).json({ error: 'this GSoC project URL is already on the wall — use "edit my badge" instead' });
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const photo = b.photoData ? await savePhoto(id, b.photoData) : '';
      const entry = {
        id,
        ...fields,
        photo,
        owner: ownerHash(email),
        createdAt: new Date().toISOString(),
      };
      await writeEntry(entry, null);
      await ghBackup('save', id, entry);
      return res.status(201).json({ badge: publicView(entry) });
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const id = clean(b.id, 60);
      const email = clean(b.email, 200);
      if (!SAFE_ID.test(id) || !email) return res.status(400).json({ error: 'id and email required' });
      const all = await readAll();
      const cur = all.find((it) => it.entry.id === id);
      if (!cur) return res.status(404).json({ error: 'badge not found' });
      // badges saved before edit existed have no owner — first valid edit claims them
      if (cur.entry.owner && cur.entry.owner !== ownerHash(email)) {
        return res.status(403).json({ error: 'this email does not match the badge owner' });
      }
      const fields = buildFields(b);
      if (!fields.name || !fields.linkedin || !fields.gsocUrl) {
        return res.status(400).json({ error: 'name, linkedin and gsocUrl are required' });
      }
      if (!fields.org && fields.roadmap.length) fields.org = fields.roadmap[0].org;
      const photo = b.photoData ? await savePhoto(id, b.photoData) : (cur.entry.photo || '');
      const entry = {
        ...cur.entry,
        ...fields,
        photo,
        owner: cur.entry.owner || ownerHash(email),
        updatedAt: new Date().toISOString(),
      };
      await writeEntry(entry, cur.pathname);
      await ghBackup('save', id, entry);
      return res.status(200).json({ badge: publicView(entry) });
    }

    if (req.method === 'DELETE') {
      const id = clean(req.query.id, 60);
      const email = clean(req.query.email, 200);
      if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'valid id required' });
      const all = await readAll();
      const cur = all.find((it) => it.entry.id === id);
      if (!cur) return res.status(200).json({ ok: true });
      if (cur.entry.owner && (!email || cur.entry.owner !== ownerHash(email))) {
        return res.status(403).json({ error: 'this email does not match the badge owner' });
      }
      await del(cur.pathname);
      await ghBackup('remove', id, null);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
}
