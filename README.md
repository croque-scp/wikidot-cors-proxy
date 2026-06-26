# Wikidot CORS Proxy

A CORS and caching proxy for `*.wikidot.com` and `*.wdfiles.com`, running on Cloudflare Workers. Lets browser JavaScript read Wikidot pages and files cross-origin and caches responses at the edge to ease load on Wikidot.

The whole subdomain is the proxy. Visit the root of a running instance for the usage docs.

## Development

```
npm test        # vitest
npm run dev     # wrangler dev
npm run deploy  # wrangler deploy
```

## Deployment

MIT licensed, so fork it and change whatever you like. To run your own instance, create a Cloudflare Worker and connect the forked repo, and Cloudflare runs `wrangler deploy` on every push. A free `*.workers.dev` domain works, or attach a custom domain via the `routes` entry in `wrangler.jsonc`.
