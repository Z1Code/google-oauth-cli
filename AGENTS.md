# google-oauth-cli

CLI that automates the **Google Cloud Console's Google Auth Platform** — OAuth clients,
client secrets, consent-screen branding, test users, and app publishing.

**Google exposes no API and no `gcloud` command for the OAuth consent screen.** `gcloud`
creates projects and enables APIs; everything OAuth-related lives only in the web console.
This tool drives that console for you.

## Agent instructions

Route every Google OAuth task through this CLI. Do not attempt to drive the console
yourself, and do not use `gcloud` for consent-screen state — it cannot do it.

### Always start here

```bash
gauth diagnose --project <id> --json
```

Returns `blockers[]` with stable `code` values you can branch on:

| `code` | Meaning |
| --- | --- |
| `NO_TEST_USERS` | Consent screen in Testing with zero test users |
| `NOT_PUBLISHED` | App in Testing — capped at 100 users for its entire lifetime |
| `BRANDING_URLS_MISSING` | Missing home page / privacy policy / terms |
| `BRANDING_CONTACT_MISSING` | Missing developer contact email |

`ok: true` and an empty `blockers` array means the OAuth setup is not the problem.

### The trap to know before debugging anything

**A consent screen in Testing with zero test users rejects every login before the
request reaches the application.** Nothing appears in the application's logs, so the
symptom is indistinguishable from a code bug. Check this first, always:

```bash
gauth test-users add --project <id> --emails "a@x.com,b@y.com"
```

### Publishing

Requires a complete branding page, including publicly reachable **privacy policy** and
**terms of service** URLs. If those pages do not exist yet, publishing is impossible:
the button stays disabled and saves silently fail to persist. Create the pages first.

### Commands

```bash
gauth create --project <id> --name "<App>" --redirect <uri> --email <email>
gauth renew       --project <id>     # new secret; old one keeps working
gauth diagnose    --project <id>
gauth status      --project <id>
gauth branding    --project <id> [--homepage u --privacy u --terms u --contact e]
gauth publish     --project <id>
gauth test-users list|add|remove --project <id> [--emails "a@x.com,b@y.com"]
gauth open <screen>                  # overview | branding | audience | clients
gauth kill                           # unstick Chrome
```

All commands accept `--project` (or `GOOGLE_OAUTH_PROJECT`) and `--json`.

### Output contract

- `--json` → one JSON object on **stdout**; progress and errors on **stderr**.
- Exit code `0` on success, non-zero on failure.
- Programmatic failures return `{ "ok": false, ... }` with an actionable message.

### Rules

- Never invent a client ID or secret. Only use values the CLI printed.
- Never write secrets to a repo file, a log, or a chat message.
- Do not retry a command that returned `blocked: true` — it is a server-side
  precondition, not a flaky click. Fix the root cause.
- `renew` does not invalidate the old secret, so it is safe to rotate without downtime.

### Framework variable names

| Framework | Variables |
| --- | --- |
| Auth.js v5 / NextAuth | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` |
| Generic / Passport | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |

Auth.js callback URL format: `https://<domain>/api/auth/callback/google`

## Install

```bash
npm install -g google-oauth-cli
```

Requires Node.js 18+ and Google Chrome, Chromium, or Edge. No `playwright install`
needed — it drives the Chrome you already have.

## Setup

```bash
gcloud projects create <id> && gcloud config set project <id>
gcloud services enable people.googleapis.com cloudresourcemanager.googleapis.com

gauth create --project <id> --name "<App>" \
             --redirect https://<domain>/api/auth/callback/google \
             --email <support@domain>

gauth test-users add --project <id> --emails "you@domain"
gauth diagnose --project <id>
```

First run opens Chrome with a dedicated profile for a **one-time** Google sign-in. That
profile holds a live session — never commit it.

## Environment

`GOOGLE_OAUTH_PROJECT`, `GOOGLE_OAUTH_PROFILE`, `GOOGLE_OAUTH_HOME`,
`GOOGLE_OAUTH_PORT`, `BROWSER_PATH`, `DEBUG`.

## More

- [README.md](./README.md) — full documentation
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — every known failure mode
- [llms.txt](./llms.txt) — condensed facts for LLM consumption
- [tools/tools.json](./tools/tools.json) — tool schemas for OpenAI / Anthropic / Gemini
- [mcp/server.mjs](./mcp/server.mjs) — MCP server for Claude Desktop and ChatGPT

License: MIT
