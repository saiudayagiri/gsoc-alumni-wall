import { list } from '@vercel/blob';

// Badges store their photo as /api/photo?id=<badge-id> — a URL under our own
// domain, so badge data stays valid if the project ever moves hosts. This
// endpoint resolves it to the current storage (Vercel Blob today); a new host
// would reimplement just this file over its own storage.
const SAFE_ID = /^[0-9]+-[a-z0-9]+$/;

export default async function handler(req, res) {
  const id = String(req.query.id || '').trim();
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'valid id required' });
  try {
    const { blobs } = await list({ prefix: `photos/${id}.` });
    if (!blobs.length) return res.status(404).json({ error: 'no photo' });
    // several revisions may exist after edits — newest wins (timestamp in pathname)
    blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(302, blobs[0].url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
}
