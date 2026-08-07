import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'crypto';

// Primary store: Supabase Postgres (one query per read — no per-record fan-out).
// Photos: Supabase Storage bucket `photos` (public), never committed to Git (#1).
// Backup: badge JSON is still mirrored to data/badges/ in the GitHub repo, which
// is what the wall was rebuilt from — kept as the durable, portable safety net.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const BUCKET = 'photos';
const GH_REPO = 'saiudayagiri/gsoc-alumni-wall';

const clean = (s, max = 200) => String(s ?? '').slice(0, max).trim();
const SAFE_ID = /^[0-9]+-[a-z0-9]+$/;
// Emails are the edit key but are never stored — only this hash.
const ownerHash = (email) =>
  createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

// Admin auth: secret lives only in Vercel env (ADMIN_KEY), never in the repo.
function isAdminReq(req) {
  const provided = String(req.headers['x-admin-key'] || '');
  const secret = String(process.env.ADMIN_KEY || '');
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

const sanitizeSigs = (v) =>
  (Array.isArray(v) ? v : []).slice(0, 4).map((s) => clean(s, 60)).filter(Boolean);

// DB row (snake_case) -> API entry (camelCase, as the frontend expects)
const fromRow = (r) => ({
  id: r.id,
  name: r.name,
  org: r.org,
  event: r.event,
  city: r.city,
  currentCity: r.current_city,
  nativeCity: r.native_city,
  year: r.year,
  role: r.role,
  linkedin: r.linkedin,
  gsocUrl: r.gsoc_url,
  owner: r.owner,
  photo: r.photo,
  roadmap: r.roadmap || [],
  socials: r.socials || [],
  sigs: r.sigs || [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const publicView = ({ owner, ...rest }) => rest;

function buildFields(b) {
  return {
    name: clean(b.name),
    linkedin: clean(b.linkedin),
    gsocUrl: clean(b.gsocUrl, 300),
    org: clean(b.org, 80),
    event: clean(b.event) || 'GSoC Alumni',
    city: clean(b.city, 60),
    currentCity: clean(b.currentCity, 60),
    nativeCity: clean(b.nativeCity, 60),
    year: clean(b.year, 4) || String(new Date().getFullYear()),
    role: clean(b.role, 40) || 'GSoCer',
    roadmap: sanitizeRoadmap(b.roadmap),
    socials: sanitizeSocials(b.socials),
    sigs: sanitizeSigs(b.sigs),
  };
}

// fields (camelCase) -> DB columns (snake_case)
const toRow = (f, extra = {}) => ({
  name: f.name, org: f.org, event: f.event, city: f.city,
  current_city: f.currentCity, native_city: f.nativeCity,
  year: f.year, role: f.role, linkedin: f.linkedin, gsoc_url: f.gsocUrl,
  roadmap: f.roadmap, socials: f.socials, sigs: f.sigs, ...extra,
});

const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const GSOC_URL_RE = /^https?:\/\/(www\.)?summerofcode\.withgoogle\.com\/archive\/\d{4}\/projects\/[\w-]+\/?$/i;

// Any pasted form -> canonical archive URL using the id after the last slash.
function normalizeGsocUrl(v, fallbackYear) {
  v = String(v || '').trim();
  if (!v) return '';
  if (GSOC_URL_RE.test(v)) return v.replace(/\/+$/, '');
  const yearInUrl = (v.match(/\/(20\d{2})\//) || [])[1];
  const id = v.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
  if (!/^[\w-]{4,}$/.test(id) || /^20\d{2}$/.test(id) ||
      ['projects', 'details', 'archive', 'myprojects', 'programs'].includes(id.toLowerCase())) return '';
  const year = yearInUrl || fallbackYear || String(new Date().getFullYear());
  return `https://summerofcode.withgoogle.com/archive/${year}/projects/${id}`;
}

const extFromDataUrl = (m) => (m[1] === 'jpeg' ? 'jpg' : m[1]);

async function savePhoto(id, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return '';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > 500000) return '';
  const ext = extFromDataUrl(m);
  await deletePhotos(id); // drop any prior revision (different ext)
  const { error } = await sb.storage.from(BUCKET).upload(`${id}.${ext}`, buf, {
    contentType: `image/${m[1]}`, upsert: true, cacheControl: '31536000',
  });
  if (error) { console.error('photo upload failed', error.message); return ''; }
  return `/api/photo?id=${id}`; // host-independent; resolved by api/photo.js
}

async function deletePhotos(id) {
  try {
    await sb.storage.from(BUCKET).remove([`${id}.jpg`, `${id}.png`, `${id}.webp`]);
  } catch (e) {
    console.error('photo cleanup failed', e);
  }
}

// Best-effort mirror of the badge JSON into the GitHub repo (data/badges/<id>.json)
// as a durable, portable backup. Stores the owner hash, never a raw email.
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
        method: 'PUT', headers,
        body: JSON.stringify({
          message: `backup: badge ${id} (${entry.name})`,
          content: Buffer.from(JSON.stringify(entry, null, 2)).toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
    } else if (action === 'remove' && sha) {
      await fetch(url, {
        method: 'DELETE', headers,
        body: JSON.stringify({ message: `backup: remove badge ${id}`, sha }),
      });
    }
  } catch (e) {
    console.error('github backup failed', e);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (req.query.checkAdmin) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ admin: isAdminReq(req) });
      }
      const email = clean(req.query.email, 200);
      if (email) {
        res.setHeader('Cache-Control', 'no-store');
        const { data, error } = await sb.from('badges').select('*').eq('owner', ownerHash(email));
        if (error) throw error;
        return res.status(200).json({ badges: data.map((r) => publicView(fromRow(r))) });
      }
      // public wall — Postgres reads are cheap; no CDN caching so edits show immediately
      const { data, error } = await sb.from('badges').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ badges: data.map((r) => publicView(fromRow(r)) ) });
    }

    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST') {
      const b = req.body || {};
      const fields = buildFields(b);
      const email = clean(b.email, 200);
      if (!fields.name || !fields.linkedin || !email || !fields.gsocUrl) {
        return res.status(400).json({ error: 'name, email, linkedin and gsocUrl are required' });
      }
      const contribYear = (fields.roadmap.find((r) => r.role === 'Contributor' && /^\d{4}$/.test(r.year)) || {}).year;
      fields.gsocUrl = normalizeGsocUrl(fields.gsocUrl, contribYear || (/^\d{4}$/.test(fields.year) ? fields.year : ''));
      if (!fields.gsocUrl) {
        return res.status(400).json({ error: 'could not read a project id from gsocUrl — paste your GSoC project link in any form' });
      }
      if (!fields.org && fields.roadmap.length) fields.org = fields.roadmap[0].org;
      if (!fields.org) return res.status(400).json({ error: 'add at least one roadmap row with your org' });

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const photo = b.photoData ? await savePhoto(id, b.photoData) : '';
      const row = toRow(fields, {
        id, owner: ownerHash(email), photo, created_at: new Date().toISOString(),
      });
      const { data, error } = await sb.from('badges').insert(row).select().single();
      if (error) {
        if (error.code === '23505') { // unique gsoc_url
          await deletePhotos(id);
          return res.status(409).json({ error: 'this GSoC project URL is already on the wall — use "edit my badge" instead' });
        }
        throw error;
      }
      const entry = fromRow(data);
      await ghBackup('save', id, entry);
      return res.status(201).json({ badge: publicView(entry) });
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const id = clean(b.id, 60);
      const email = clean(b.email, 200);
      if (!SAFE_ID.test(id) || !email) return res.status(400).json({ error: 'id and email required' });
      const { data: cur } = await sb.from('badges').select('*').eq('id', id).maybeSingle();
      if (!cur) return res.status(404).json({ error: 'badge not found' });
      if (cur.owner && cur.owner !== ownerHash(email)) {
        return res.status(403).json({ error: 'this email does not match the badge owner' });
      }
      const fields = buildFields(b);
      if (!fields.name || !fields.linkedin || !fields.gsocUrl) {
        return res.status(400).json({ error: 'name, linkedin and gsocUrl are required' });
      }
      const contribYear = (fields.roadmap.find((r) => r.role === 'Contributor' && /^\d{4}$/.test(r.year)) || {}).year;
      fields.gsocUrl = normalizeGsocUrl(fields.gsocUrl, contribYear || (/^\d{4}$/.test(fields.year) ? fields.year : ''));
      if (!fields.gsocUrl) return res.status(400).json({ error: 'could not read a project id from gsocUrl' });
      if (!fields.org && fields.roadmap.length) fields.org = fields.roadmap[0].org;
      const photo = b.photoData ? await savePhoto(id, b.photoData) : (cur.photo || '');
      const row = toRow(fields, {
        owner: cur.owner || ownerHash(email), photo, updated_at: new Date().toISOString(),
      });
      const { data, error } = await sb.from('badges').update(row).eq('id', id).select().single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'that GSoC project URL is already on the wall' });
        throw error;
      }
      const entry = fromRow(data);
      await ghBackup('save', id, entry);
      return res.status(200).json({ badge: publicView(entry) });
    }

    if (req.method === 'DELETE') {
      const id = clean(req.query.id, 60);
      const email = clean(req.query.email, 200);
      if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'valid id required' });
      const { data: cur } = await sb.from('badges').select('owner').eq('id', id).maybeSingle();
      if (!cur) return res.status(200).json({ ok: true });
      if (!isAdminReq(req) && cur.owner && (!email || cur.owner !== ownerHash(email))) {
        return res.status(403).json({ error: 'this email does not match the badge owner' });
      }
      await sb.from('badges').delete().eq('id', id);
      await deletePhotos(id);
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
