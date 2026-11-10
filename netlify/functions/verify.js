// Netlify function: GET /api/verify?session_id=cs_...  or  ?email=...  (see redirect in netlify.toml)
import { verifyPurchase } from '../../server/verify-core.js';

export const handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const result = await verifyPurchase({ sessionId: q.session_id, email: q.email }, process.env.STRIPE_SECRET_KEY);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'verify failed' }) };
  }
};
