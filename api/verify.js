// Vercel serverless function: GET /api/verify?session_id=cs_...  or  ?email=...
import { verifyPurchase } from '../server/verify-core.js';

export default async function handler(req, res) {
  try {
    const { session_id: sessionId, email } = req.query || {};
    const result = await verifyPurchase({ sessionId, email }, process.env.STRIPE_SECRET_KEY);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: 'verify failed' });
  }
}
