# google-oauth-cli

**Create, rotate, publish and inspect Google OAuth 2.0 credentials from the terminal — by automating the Google Cloud Console with Playwright.**

Google has no API for the OAuth consent screen. The client secret, the branding form, the
test-user list and the publish button live only in the web console. `gcloud` can create
projects and enable APIs, but it cannot touch any of that.

So this tool drives the console for you.

```bash
npx google-oauth-cli create \
  --project my-app-492517 \
  --name "My App" \
  --redirect https://myapp.com/api/auth/callback/google \
  --email support@myapp.com
# → {"clientId":"...apps.googleusercontent.com","clientSecret":"GOCSPX-..."}
```

---

## Why this exists

If you have ever set up Google Sign-In, you have hit at least one of these:

| Problem | Symptom |
|---|---|
| Consent screen left in **Testing** with **zero test users** | Login fails for *everyone*. Google rejects the request **before** it reaches your app, so **your logs show nothing**. |
| New OAuth client, consent screen never configured | `redirect_uri_mismatch`, or a blank consent screen. |
| Lost or leaked client secret | You have to click through the console to add a new one. |
| App stuck in Testing | Hard cap of **100 users across the entire lifetime of the app**, not per year. |
| "Publish app" button greyed out | Google requires branding (home page, privacy policy, terms, developer contact) to be complete first — and the failure gives you no details. |

That first row is the killer. It looks exactly like a broken OAuth integration, and there is
nothing in your application logs to debug, because your application was never called.

`google-oauth-cli diagnose` tells you which of these you are in:

```
$ gauth diagnose --project my-app-492517

my-app-492517
Estado: Prueba   Usuarios de prueba: 0

Campos de marca vacios
  ! Vínculo a la Política de Privacidad de la aplicación
  ! Vínculo a las Condiciones del Servicio de la aplicación

Bloqueos

  NO_TEST_USERS
  La app esta en Prueba y no tiene usuarios de prueba: Google rechaza el login
  ANTES de llegar a tu app, asi que no vas a ver nada en tus logs.
  → gauth test-users add --project <id> --emails a@x.com,b@y.com
```

---

## Install

Requires **Node.js 18+** and **Google Chrome** (or Edge/Chromium).

```bash
npm install -g google-oauth-cli
```

Or without installing:

```bash
npx google-oauth-cli --help
```

**First run:** Chrome opens with a dedicated automation profile. Sign in to Google **once** —
the session is stored in that profile and reused forever after.

> The profile directory holds cookies for your Google account. It is listed in
> `.gitignore` for a reason: **never commit it.**

---

## Commands

| Command | What it does |
|---|---|
| `create` | Creates an OAuth Web Client (ID + secret), configuring the consent screen if needed |
| `renew` | Adds a new secret to an existing client — the old one keeps working |
| `diagnose` | Full health check: publish state, branding gaps, test users, and a fix for each blocker |
| `status` | Publish state only |
| `branding` | Reads or fills the branding page (home page, privacy, terms, developer contact) |
| `publish` | Publishes the app so it is no longer capped at 100 users |
| `test-users list \| add \| remove` | Manages the test-user allowlist |
| `open [screen]` | Opens a console screen in the automated Chrome, for anything not covered |
| `kill` | Kills the automation Chrome when it gets stuck |

Every command supports `--json` for scripting and agent use, and `--project` (or the
`GOOGLE_OAUTH_PROJECT` env var).

```
--project <id>     GCP project id
--json             Machine-readable output
--port <n>         Chrome debug port (default 9222)
--profile <dir>    Chrome profile directory
--settle <ms>      Extra wait after each screen loads
```

---

## Typical flows

### Set up Google Sign-In for a new project

```bash
# 1. Create the client
gauth create --project my-app-492517 --name "My App" \
             --redirect https://myapp.com/api/auth/callback/google \
             --email support@myapp.com

# 2. While the app is in Testing, allow the people who need to log in
gauth test-users add --project my-app-492517 --emails "me@x.com,qa@x.com"

# 3. Check that nothing is blocking the login
gauth diagnose --project my-app-492517
```

### Go to production (remove the 100-user cap)

Publishing requires the branding page to be complete, including **publicly reachable**
privacy policy and terms URLs. If those pages do not exist yet, create them first —
Google will not let you publish without them, and it will not tell you why.

```bash
gauth branding --project my-app-492517 \
  --homepage https://myapp.com \
  --privacy  https://myapp.com/privacy \
  --terms    https://myapp.com/terms \
  --contact  support@myapp.com

gauth publish --project my-app-492517
```

### Rotate a leaked secret

```bash
gauth renew --project my-app-492517
```

Adds a new secret and prints it. The previous secret stays valid until you delete it in the
console, so there is no downtime if you rotate carefully.

---

## Using it from a script or an AI agent

`--json` is designed for machine consumption: a single JSON object on stdout, human-readable
progress on stderr, and a non-zero exit code on failure.

```bash
gauth diagnose --project my-app-492517 --json | jq '.blockers[].code'
```

```json
{
  "project": "my-app-492517",
  "publish": { "publishingStatus": "testing", "publishEnabled": false },
  "testUsersCount": 0,
  "blockers": [
    { "code": "NOT_PUBLISHED", "detail": "...", "fix": "gauth publish --project <id>" },
    { "code": "BRANDING_URLS_MISSING", "detail": "...", "fix": "..." },
    { "code": "NO_TEST_USERS", "detail": "...", "fix": "..." }
  ],
  "ok": false
}
```

The blocker `code` values are stable, so you can branch on them instead of parsing prose.

---

## How it works

Google Chrome is launched with a dedicated `--user-data-dir` and
`--remote-debugging-port`, and Playwright attaches over CDP:

```
launch Chrome  →  connectOverCDP  →  drive the Angular console  →  read the result
```

The console is a heavy Angular SPA, which breaks most naive Playwright code. The
non-obvious parts are documented in `docs/TROUBLESHOOTING.md`, and the reasons are in
comments next to the code that depends on them. Highlights:

- `waitUntil: "networkidle"` **never fires** on the console. Use `domcontentloaded` + a fixed settle.
- `locator.filter({ visible: true })` **does not exist** in Playwright.
- `getByRole(...).click()` may not register a save even when the button is visible and
  enabled. The JS click in `clickByText()` does.
- Reloading immediately after saving gives a **false negative**. Wait for the dialog to close.
- Console inputs have **no `aria-label`** — fields must be identified by surrounding text.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_PROJECT` | Default `--project` |
| `GOOGLE_OAUTH_PROFILE` | Chrome profile directory to use |
| `GOOGLE_OAUTH_HOME` | Base directory for the automation data |
| `GOOGLE_OAUTH_PORT` | Chrome debug port |
| `BROWSER_PATH` | Path to Chrome/Edge if it is not auto-detected |
| `DEBUG` | Print full stack traces on error |

Want to reuse a Chrome profile that is already signed in to the right Google account? Point
`GOOGLE_OAUTH_PROFILE` at it. Do not point it at your everyday Chrome profile while Chrome is
running — Chrome will hand off to the existing process and the debug port will never open.

---

## Security

- The automation profile stores a **live Google session**. Treat it as a credential.
- Nothing is sent anywhere except to Google. There is no telemetry, no analytics, no
  network calls to third parties.
- `create` and `renew` print secrets to **stdout**. Do not log that output in CI.
- Prefer running this on your own machine, not a shared box.

---

## Requirements

- Node.js 18 or newer
- Google Chrome, Chromium, or Microsoft Edge
- A Google account with permission to edit the GCP project (Owner or Editor)
- `playwright` (installed automatically as a dependency; it does **not** need
  `playwright install`, because it drives the Chrome you already have)

---

## License

MIT
