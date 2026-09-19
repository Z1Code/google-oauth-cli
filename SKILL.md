---
name: google-oauth-cli
description: Create, rotate, publish and inspect Google OAuth 2.0 credentials by automating the Google Cloud Console. Use for ANY task involving a Google client ID or client secret, Google Sign-In, Auth.js/NextAuth Google provider, redirect_uri_mismatch, "Google login not working", consent screen, test users, or publishing an OAuth app out of Testing mode. Also use when a login fails and the application logs are empty — that is the signature of a consent screen in Testing with no test users.
metadata:
  priority: 9
  promptSignals:
    phrases:
      - "google oauth"
      - "oauth client"
      - "client id"
      - "client secret"
      - "google sign in"
      - "google login not working"
      - "redirect_uri_mismatch"
      - "AUTH_GOOGLE_ID"
      - "AUTH_GOOGLE_SECRET"
      - "consent screen"
      - "test users"
      - "publish oauth app"
      - "conectar google"
      - "login con google"
    minScore: 3
---

# google-oauth-cli

Wrapper around a CLI. Never hand-edit console state; call the CLI.

## The rule

Run `gauth ...` and read the JSON. Do not try to drive the Cloud Console yourself,
and do not reach for `gcloud` for anything below — **the OAuth consent screen has no
API and no gcloud command**. `gcloud` only creates projects and enables APIs.

## Start here, always

```bash
gauth diagnose --project <id> --json
```

This is the single most useful call. It returns `blockers[]` with a stable `code`
you can branch on:

| `code` | Meaning |
|---|---|
| `NO_TEST_USERS` | Consent screen in Testing with zero test users → **every login is rejected before reaching the app** |
| `NOT_PUBLISHED` | App is in Testing, capped at 100 users for its entire lifetime |
| `BRANDING_URLS_MISSING` | Missing home page / privacy policy / terms → publishing is blocked |
| `BRANDING_CONTACT_MISSING` | Missing developer contact email |

`ok: true` with an empty `blockers` means the OAuth setup is not the problem — look
elsewhere.

## The two facts that matter most

**1. A consent screen in Testing with zero test users rejects every login, before the
request reaches the application.** Your app logs stay empty, so it looks like a code
bug. It is not. Fix:

```bash
gauth test-users add --project <id> --emails "a@x.com,b@y.com"
```

**2. Publishing requires a complete branding page**, including publicly reachable
privacy policy and terms URLs. If those pages do not exist on the site, publishing is
impossible — the button stays disabled and saves silently do not persist. Do not
retry the click; create the pages first.

## Commands

```bash
gauth create --project <id> --name "<App>" \
             --redirect <https://domain/api/auth/callback/google> \
             --email <support@domain>
gauth renew      --project <id>                 # new secret; the old one keeps working
gauth diagnose   --project <id>                 # blockers + fixes
gauth status     --project <id>                 # publish state only
gauth branding   --project <id>                 # read branding fields
gauth branding   --project <id> --homepage <url> --privacy <url> --terms <url> --contact <email>
gauth publish    --project <id>
gauth test-users list   --project <id>
gauth test-users add    --project <id> --emails "a@x.com,b@y.com"
gauth test-users remove --project <id> --emails "a@x.com"
gauth kill                                      # unstick Chrome
```

Always pass `--json` when you are consuming the output.

## How to work

1. `gauth diagnose --json` → read `blockers[]`.
2. Resolve blockers in this order: missing test users → branding → publish.
3. Re-run `diagnose` to confirm `ok: true`. Do not assume a fix worked.

## Rules

- **Never invent a client ID or secret.** Only use values the CLI printed.
- **Never send secrets to a log, a file in the repo, or a chat message.** `create` and
  `renew` print them on stdout; capture them into the project `.env` directly.
- **Do not retry a command that returned `blocked: true`.** That is a server-side
  precondition, not a flaky click. Fix the blocker instead.
- **`renew` is safe.** It adds a secret; the previous one keeps working until deleted
  in the console. No downtime.
- Variable names by framework: Auth.js v5 → `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`;
  generic → `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.

## Requirements

`gcloud` for project creation only. If the project does not exist:

```bash
gcloud projects create <id> && gcloud config set project <id>
gcloud services enable people.googleapis.com cloudresourcemanager.googleapis.com
```

The first `gauth` run opens Chrome with a dedicated profile for a one-time Google
sign-in. That profile holds a live session — never commit it.

## If something fails

`gauth` returns `{ "ok": false, ... }` and a non-zero exit code. Read the message: it
is written to be actionable. `docs/TROUBLESHOOTING.md` in the repo covers every known
failure mode, including the Chrome/CDP traps.

Full docs: https://github.com/Z1Code/google-oauth-cli
