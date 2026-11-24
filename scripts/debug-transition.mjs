import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
for (const line of env.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const ESTIMATE_SELECT = `
  *,
  line_items:estimate_line_items(*),
  project:projects(id, name),
  account:accounts(id, name)
`;

const { data, error } = await supabase
  .from('estimates')
  .select(ESTIMATE_SELECT)
  .eq('id', '7b15b31d-683b-439f-b6c9-d0763c428ec6')
  .eq('account_id', 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001')
  .is('deleted_at', null)
  .maybeSingle();

console.log('error:', error);
console.log('data:', data ? { id: data.id, status: data.status, number: data.estimate_number } : null);
