import { createClient } from '@supabase/supabase-js';

// build: supabase-storage v2
// Badges store their photo as /api/photo?id=<badge-id> — a URL on our own
// domain, so badge data stays valid if storage ever changes. Resolves to the
// public Supabase Storage URL. Photos still stuck in the (blocked) legacy Blob
// store simply 404 here, and the wall falls back to initials.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const BUCKET = 'photos';
const SAFE_ID = /^[0-9]+-[a-z0-9]+$/;

export default async function handler(req, res) {
  const id = String(req.query.id || '').trim();
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'valid id required' });
  try {
    const { data, error } = await sb.storage.from(BUCKET).list('', { search: id, limit: 10 });
    if (error) throw error;
    const file = (data || []).find((f) => f.name.startsWith(`${id}.`));
    if (!file) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(404).json({ error: 'no photo' });
    }
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(file.name);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(302, pub.publicUrl);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
}
