// GET /api/stats?key=...  ->  JSON summary of the last 60 days. Needs the STATS_KEY environment variable.
import { getStore } from '@netlify/blobs';
import { summary } from '../../server/usage-core.js';

export default async (req) => {
  const expected = process.env.STATS_KEY;
  const key = new URL(req.url).searchParams.get('key');
  if (!expected || key !== expected) return new Response('Not found', { status: 404 });
  const data = await summary(getStore({ name: 'usage', consistency: 'strong' }), 60);
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/stats' };
