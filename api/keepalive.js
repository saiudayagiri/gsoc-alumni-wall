import { createClient } from '@supabase/supabase-js';

// Free Supabase projects pause after ~7 days with no activity. A tiny daily
// query (run by Vercel Cron — see vercel.json) counts as activity and keeps the
// project awake, so the wall never goes to sleep between events.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { count, error } = await sb.from('badges').select('*', { count: 'exact', head: true });
    if (error) throw error;
    return res.status(200).json({ ok: true, badges: count, at: new Date().toISOString() });
  } catch (e) {
    console.error('keepalive failed', e);
    return res.status(500).json({ ok: false });
  }
}
