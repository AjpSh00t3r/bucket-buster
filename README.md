# Bucket Buster

> ⚠️ **Run this on your own machine only — do not deploy it to a public server.**
> The bucket probing happens *server-side*, from the Node process. On localhost that's
> fine — you're checking your own brand. Exposed on a public host it becomes an open
> bucket-enumeration proxy that anyone could drive, with every request coming from **your**
> server's IP. It is name-locked to the submitted brand and read-only, but it still
> binds to `127.0.0.1` by default. Keep it there.

Find the publicly-exposed S3 and Google Cloud Storage buckets sitting under **your own**
brand name, and see exactly what's listable in them — before someone else does.

```bash
npm start      # → http://127.0.0.1:4778
```

No dependencies (Node ≥ 20). The server binds to localhost only.

## What it does

1. From one brand you enter, it builds common bucket-name permutations:
   `brand`, `brand-assets`, `brand-backups`, `brand-dev`, `brand-media`, `brand-static`,
   `brand-uploads`, plus other common suffixes (`-prod`, `-logs`, `-cdn`, `-private`, …).
2. For each name it makes an **anonymous, server-side GET** to:
   - S3 — `https://NAME.s3.amazonaws.com/?list-type=2`
   - GCS — `https://storage.googleapis.com/storage/v1/b/NAME/o`
3. It parses the `ListBucketResult` XML / GCS JSON and streams every object **key, size and a
   direct link** back to the page, which pours them down the screen while a counter climbs
   to the real total. Up to ~3000 objects per bucket are listed.
4. Buckets that exist but refuse anonymous listing (HTTP 403) are counted as
   "exist but locked", not opened.

## Real data only

Every file card and the counter come straight from the real bucket response. Nothing is
invented. If no permutation is publicly listable you get an honest
"No public bucket found", with the count of names checked.

## Scope & safety

- **Locked to your brand.** The server generates the names itself from the submitted brand
  and validates them against S3 naming rules. It never accepts or fetches an arbitrary
  bucket name, so you can't point it at someone else's bucket by name.
- **Required attestation.** The UI checkbox and an `own=1` parameter are both required.
- **Read-only, public-only.** It only issues anonymous GET list calls — the same data any
  unauthenticated visitor could already read. It never writes, deletes, downloads object
  bodies, or authenticates.
- Why a local server and not browser-only: S3 and GCS send no CORS headers for these calls,
  so a browser `fetch` would be blocked. The Node server makes the calls instead.

## Try it

A clean public-data test:

```bash
npm start
# then scan the brand:  commoncrawl   → finds commoncrawl-public (open dataset)
```

(That's a deliberately public open-data bucket, used here only to exercise the parser.)

## Defence (shown in-app)

Turn on **S3 Block Public Access** (account- and bucket-level) and the GCS equivalent,
**disable anonymous/public listing**, remove `allUsers` / `AllUsers` grants, and put anything
that must be public behind a CDN with an explicit allowlist.
