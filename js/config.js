// App settings. Edit this file to turn on payments; see README "Getting paid".
export const CONFIG = {
  appName: 'At-Bat Log',
  version: '1.0.0',
  supportEmail: '', // shown on the Settings and Privacy pages when set

  // Features being rolled out over time. Flip one to true to ship it.
  features: {
    insights: false, // plain-language takeaways on the season report
    trends: false,   // game-by-game sparklines on the season report
  },

  pro: {
    // false = no paid tier: no upgrade UI anywhere, and every feature switched on above is free.
    // true = the season deep-dive (plus insights/trends if switched on) needs Pro.
    enabled: false,
    // Shown on the Pro page. `url` is a Stripe Payment Link (or any checkout link).
    // Leave url empty until your payment links exist; the buttons then say payments aren't live yet.
    plans: [
      { id: 'yearly', name: 'Yearly', price: '$14.99', per: 'year', note: 'Best value', url: '' },
      { id: 'monthly', name: 'Monthly', price: '$2.99', per: 'month', note: '', url: '' },
    ],
    // Serverless endpoint that confirms a purchase with Stripe ('/api/verify' once deployed with
    // STRIPE_SECRET_KEY set). Empty = trust the redirect back from checkout (fine for a soft launch).
    verifyUrl: '',
    // Stripe customer-portal link so subscribers can cancel or update their card.
    manageUrl: '',
  },
};
