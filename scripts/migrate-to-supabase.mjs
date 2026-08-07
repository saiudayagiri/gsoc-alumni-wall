// One-time migration: seed the Supabase `badges` table from the GitHub-backup
// JSON files in data/badges/. Safe to re-run (upsert on id). Photos are left
// as-is (their /api/photo URL); those still in the blocked Blob store are
// migrated separately once Blob is unblocked.
//
//   node scripts/migrate-to-supabase.mjs
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const dir = join(root, 'data', 'badges');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const rows = files.map((f) => {
  const b = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return {
    id: b.id,
    name: b.name || '',
    org: b.org || '',
    event: b.event || 'GSoC Alumni',
    city: b.city || '',
    current_city: b.currentCity || b.homeCity || '',
    native_city: b.nativeCity || '',
    year: b.year || '',
    role: b.role || 'GSoCer',
    linkedin: b.linkedin || '',
    gsoc_url: b.gsocUrl || '',
    owner: b.owner || '',
    photo: b.photo || '',
    roadmap: b.roadmap || [],
    socials: b.socials || [],
    sigs: b.sigs || [],
    created_at: b.createdAt || new Date().toISOString(),
    updated_at: b.updatedAt || null,
  };
});

const { error, count } = await sb.from('badges').upsert(rows, { onConflict: 'id', count: 'exact' });
if (error) {
  console.error('migration failed:', error.message);
  process.exit(1);
}
console.log(`migrated ${rows.length} badges into Supabase.`);
const { count: total } = await sb.from('badges').select('*', { count: 'exact', head: true });
console.log(`badges table now holds ${total} rows.`);
