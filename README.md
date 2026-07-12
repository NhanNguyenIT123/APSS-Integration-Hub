# APSS Portal Integration Hub

Unified workspace for the APSS procurement portal automation initiative.

This `my-extension/` folder is the actual Git repository intended for publishing and review.
The parent `pttep-integration/` folder is only a local workspace container on the machine.

This solution combines:

- a Business Central per-tenant extension under `app/`
- a shared Node.js middleware layer under `shared/`
- a PTTEP portal adapter under `pttep/`
- a POSCO portal adapter under `posco/`
- a local web dashboard under `public/`

## Structure

- `app/` - Business Central AL extension
- `shared/` - middleware server, pipeline, BC client, matching logic
- `pttep/` - PTTEP-specific scraper and local portal session assets
- `posco/` - POSCO-specific scraper and local portal session assets
- `public/` - APSS Integration Hub local UI
- `sample-data/` - public-safe demo sample and local-only matching fallback

## Local run

From `my-extension/`:

```bash
npm install
npm start
```

The current demo flow is local-first:

1. Run the middleware locally
2. Run the BC extension in the target sandbox
3. If BC must call the local middleware, expose it through a tunnel
4. Keep live credentials, sessions, browser profiles, and raw customer exports out of version control

For local BC simulation fallback:

- `sample-data/bc_existing_items.example.json` is the safe public demo sample kept in Git
- `sample-data/bc_existing_items.local.json` is the real local-only sample file used on the developer machine when present

## Sensitive local files

The following are intentionally excluded from Git:

- `config.json`
- `sample-data/bc_existing_items.local.json`
- `pttep/session.json`
- `pttep/.browser-profile/`
- `posco/session.json`
- `tunnel_url.txt`
- `output/`, `temp/`, `scratch/`

Use `config.example.json` as the template for local configuration.
