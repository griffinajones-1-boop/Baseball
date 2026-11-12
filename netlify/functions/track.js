// POST /api/track  { events: ["open", "game", ...] }  ->  204
import { getStore } from '@netlify/blobs';
import { cleanEvents, record } from '../../server/usage-core.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const events = cleanEvents(body && body.events);
  if (events.length) {
    try {
      await record(getStore({ name: 'usage', consistency: 'strong' }), events);
    } catch (e) {
      console.error('usage record failed', e);
      return new Response('Unavailable', { status: 503 });
    }
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/track' };
