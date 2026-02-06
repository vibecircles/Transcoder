Transcoder Worker (Backend Only)
===============================

This package is intentionally isolated from the frontend so heavy dependencies
do not impact Vercel builds.

Requirements
------------
- Node 18+ (for built-in `fetch`)
- ffmpeg binary (bundled via `ffmpeg-static`)
- Supabase service role key
- Cloudflare R2 (S3-compatible) credentials

Install
-------
```bash
cd tools/transcoder
npm install
```

Copy env
--------
Fill out the template in `tools/transcoder/.env.example` and load it in your
runtime environment.

Environment
-----------
Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `R2_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Optional:
- `TRANSCODER_MODE=active` (default is `dry-run`)
- `TRANSCODER_POLL_MS=10000`
- `TRANSCODER_FAKE_SUCCESS=1` (simulate successful jobs without ffmpeg)

Run
---
```bash
npm start
```

Behavior
--------
- `dry-run` logs pending jobs without processing.
- `active` downloads source files, runs ffmpeg, uploads HLS + poster to R2,
  and updates the `transcode_jobs` table with result metadata.
