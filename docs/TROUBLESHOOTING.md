# Troubleshooting

Everything here was learned by hitting it. Each item says what you see and what is
actually happening.

---

## "Google login does not work" and my app logs are empty

**The most common cause, by far.** Your OAuth consent screen is in **Testing** mode and has
**zero test users**.

Google rejects the sign-in request *before it ever reaches your application*. There is no
request to log, no error to catch, no stack trace. It looks exactly like a broken integration.

```bash
gauth test-users list --project <id>      # confirms: (ninguno)
gauth test-users add  --project <id> --emails "you@x.com,qa@x.com"
gauth diagnose        --project <id>      # confirms: no blockers
```

This trap is why `create` is not the end of the setup, and why the console left with an empty
test-user list is so damaging.

---

## "Publish app" is greyed out

Google requires the **branding page** to be complete before an app can be published:

- home page URL
- **privacy policy URL** (must be publicly reachable — a 404 will not do)
- **terms of service URL**
- developer contact email

The console only says *"you must complete the configuration on the branding page"* and does not
tell you which field is missing. `gauth diagnose` reads the actual field values and reports
which ones are empty.

If those pages do not exist on your site yet, **create them first**. There is no way to publish
without them.

---

## I filled in branding, "Guardar" became enabled, I clicked it, and nothing persisted

Two things cause this:

1. **Missing required fields** (usually privacy policy / terms). Google accepts the click,
   rejects the save server-side, and shows no obvious error.
2. **The value never reached Angular's form control.** The console is Angular Material; setting
   the DOM value without dispatching an `input` event leaves the control unaware, so the save
   submits nothing.

This tool dispatches the event, and then **reloads and re-reads the fields** to verify that the
value actually persisted. It reports per-field `persisted: true/false` rather than claiming
success. If it says `NO persistio`, believe it — check the required fields above.

---

## `Chrome no abrio el puerto de depuracion 9222`

Chrome was already running with the same profile, so the new process handed its arguments to the
existing instance and exited. The existing instance ignores `--remote-debugging-port`, so the port
never opens and you wait forever.

```bash
gauth kill
gauth <command> --project <id>
```

Do not point `GOOGLE_OAUTH_PROFILE` at the Chrome profile you use every day while Chrome is
running.

---

## `Protocol error (Target.createTarget): Failed to open a new tab`

The Chrome instance got into a state where it is alive but cannot open tabs — normally after
every tab was closed. The tool avoids closing the last tab for this reason. If it happens:

```bash
gauth kill
```

---

## `connect ECONNREFUSED 127.0.0.1:9222`

Something killed the automation Chrome mid-run (or a second script killed it). The tool retries
once by relaunching Chrome; if it keeps happening, another process is competing for port 9222. Use
`--port 9223`.

---

## Screenshots come out wrong, or hang

`page.screenshot()` can hang on the console waiting for fonts. This tool deliberately does not use
screenshots for verification — it reads `document.body.innerText`. If you write your own scripts,
do the same.

---

## "No encontre el boton ..."

Google renames buttons and reflows this UI regularly. When a click fails, the tool returns
`{ ok: false, candidates: [...] }` with the actual button labels it saw, so you can see what the
UI looks like now instead of guessing.

Please open an issue with that list if a selector breaks.

---

## Writing your own automation against this console

The traps that cost the most time, in order:

1. **`waitUntil: "networkidle"` never fires.** The console is a SPA with permanent connections.
   Use `domcontentloaded` plus a fixed settle.
2. **`locator.filter({ visible: true })` does not exist** in Playwright. It is
   `has` / `hasNot` / `hasText` / `hasNotText`. For visibility use the `:visible` pseudo-class.
3. **`getByRole(...).click()` does not always register a save**, even when the element is visible
   and inside the overlay. A JS `.click()` on the found element does.
4. **Reloading straight after saving gives a false negative.** Wait for the dialog to disappear
   first.
5. **Console inputs have no `aria-label`.** Identify fields by the text of their surrounding
   block.
6. **Scope your CSS.** A rule like `.pane::after { position: absolute; inset: 0 }` applies to
   every element with that class; if one of them is not `position: relative`, the overlay sizes
   itself against a distant ancestor and covers the whole page.
7. **Chip-list fields do not store their value in `el.value`.** The developer contact emails and
   the test-user list are both `mat-chip-grid`: the value only becomes a chip when you press
   Enter, and afterwards the input is **deliberately empty**. Reading `el.value` makes a filled
   field look empty, which produces false "missing" reports, and setting `el.value` makes the
   save silently do nothing. Type with real keyboard events (`typeIntoField`) and read the chip
   elements, not the input.
8. **A disabled "Save" button is not always a bug.** If nothing actually changed, Angular keeps
   it disabled. Check whether the value you tried to write was already there before assuming the
   write failed.

The reusable pieces live in `lib/console.mjs` — read the comments there before writing new code.
