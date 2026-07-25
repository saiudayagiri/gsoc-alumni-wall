# GSoC Alumni Badge Wall

A community wall of conference badges from Google Summer of Code alumni.
Every alum hangs as a badge modeled on a real GSoC event badge — flip a card to
see their GSoC roadmap (contributor years, mentor years, orgs) and open their
LinkedIn to connect.

**Live site:** https://gsoc-alumni-wall.vercel.app

> An unofficial community project, not affiliated with Google.
> "Google Summer of Code" belongs to Google LLC.

## How it works

- `index.html` — the whole frontend: hero badge, the wall (search, year filters,
  flip cards), and the "Hang your badge" registration form. No framework, no
  build step.
- `api/badges.js` — a Vercel serverless function backing the shared wall.
  Each badge is stored as its own immutable file (`badges/<id>.json`) in a
  Vercel Blob store; `list()` metadata is the source of truth, so reads are
  always fresh despite CDN caching. Endpoints: `GET`, `POST`, `DELETE /api/badges`.

## Run it locally

```bash
npm install
vercel dev
```

Without a linked Blob store the page still works — badges then persist to the
visitor's localStorage instead of the shared wall.

## Contributing

Issues and pull requests are welcome. Some known gaps if you want somewhere to
start:

- No spam protection or moderation on badge submissions
- Deletion is only restricted client-side (the API will delete any id)
- Sample placeholder cards should retire once enough real alumni join

## Deploy

```bash
vercel deploy --prod --yes
```

Started by [sai udayagiri](https://www.linkedin.com/in/sai-udayagiri/) — GSoC 2025 contributor, SymPy.
