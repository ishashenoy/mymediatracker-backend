const { PostHog } = require('posthog-node');

const client = new PostHog(process.env.POSTHOG_KEY, {
  host: process.env.POSTHOG_HOST,
});

module.exports = client;
