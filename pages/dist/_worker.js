// Relay — Cloudflare Pages front door (https://kafkas-relay.pages.dev)
// Όλη η λογική (UI, API, auth, email capture, cron) μένει στον Worker "relay".
// Το Pages απλώς προωθεί κάθε request μέσω service binding, κρατώντας το hostname
// kafkas-relay.pages.dev (ώστε cookies/magic links να δένονται σε αυτό).
export default {
  async fetch(request, env) {
    return env.RELAY.fetch(request);
  },
};
