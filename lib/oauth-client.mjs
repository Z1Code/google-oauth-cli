#!/usr/bin/env node
/**
 * Google OAuth 2.0 client automation via Playwright.
 * Cross-platform: Windows, macOS, Linux.
 *
 * MODES:
 *   create  <project-id> <app-name> <redirect-uri> <support-email>
 *           Creates a new OAuth Web Client ID (with consent screen if needed).
 *
 *   renew   <project-id>
 *           Adds a new secret to the first OAuth client in the project.
 *           Use when credentials are lost, expired, or need rotating.
 *
 * OUTPUT (stdout, JSON):
 *   { "clientId": "...", "clientSecret": "GOCSPX-..." }
 *
 * First run: Chrome opens visibly — sign in once. Session saved to chrome-profile/.
 * Subsequent runs: fully automatic (session reused).
 *
 * Requirements:
 *   - Node.js 18+
 *   - npm install playwright
 *   - Google Chrome installed
 */

import { chromium } from "playwright-core";
import os from "os";
import path from "path";
import { spawnSync, spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";

// ─── Platform detection ────────────────────────────────────────────────────────

const IS_WIN   = process.platform === "win32";
const IS_MAC   = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

/** Find Google Chrome executable — returns path or throws. */
function findChrome() {
  if (IS_WIN) {
    const candidates = [
      path.join(process.env["ProgramFiles"]  ?? "C:\\Program Files",        "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["LOCALAPPDATA"]  ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    ];
    const found = candidates.find(existsSync);
    if (found) return found;
    throw new Error("Chrome not found. Install from https://www.google.com/chrome/");
  }
  if (IS_MAC) {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(mac)) return mac;
    throw new Error("Chrome not found at /Applications/Google Chrome.app");
  }
  // Linux
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error("Chrome not found. Install via: sudo apt install google-chrome-stable");
}

/** Kill any Chrome instance using our debug port. */
function killChromeOnPort(port) {
  if (IS_WIN) {
    // Find PID using the debug port via netstat, then kill it
    const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const line = netstat.stdout?.split("\n").find(l => l.includes(`:${port}`) && l.includes("LISTENING"));
    if (line) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid) spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
    }
  } else {
    // Mac / Linux
    const pid = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }).stdout.trim();
    if (pid) {
      for (const p of pid.split("\n").filter(Boolean)) {
        spawnSync("kill", ["-9", p], { stdio: "ignore" });
      }
    }
  }
}

/** Check if the Chrome debug port is listening. */
function isPortReady(port) {
  const r = spawnSync(
    IS_WIN ? "powershell" : "curl",
    IS_WIN
      ? ["-Command", `(New-Object System.Net.Sockets.TcpClient).Connect('127.0.0.1', ${port}); $true`]
      : ["-s", "--max-time", "1", `http://127.0.0.1:${port}/json/version`],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  if (IS_WIN) return r.status === 0;
  return r.stdout?.includes("webSocketDebuggerUrl") ?? false;
}

/** Open a URL in the system browser (for error messages). */
function openBrowser(url) {
  if (IS_WIN) spawnSync("start", [url], { shell: true });
  else if (IS_MAC) spawnSync("open", [url]);
  else spawnSync("xdg-open", [url]);
}

// ─── Paths ─────────────────────────────────────────────────────────────────────

const SKILL_DIR       = process.env.GOOGLE_OAUTH_HOME ?? path.join(os.homedir(), ".google-oauth-cli");
const CHROME_PROFILE  = process.env.GOOGLE_OAUTH_PROFILE ?? path.join(SKILL_DIR, "chrome-profile");
const DEBUG_PORT      = Number(process.env.GOOGLE_OAUTH_PORT ?? 9222);
const LOG_FILE        = IS_WIN ? path.join(os.tmpdir(), "oauth-setup.log") : "/tmp/oauth-setup.log";

mkdirSync(CHROME_PROFILE, { recursive: true });

// ─── CLI args ──────────────────────────────────────────────────────────────────

const [, , MODE, ...args] = process.argv;

if (MODE !== "create" && MODE !== "renew") {
  console.error("Usage:");
  console.error("  node oauth-client.mjs create <project-id> <app-name> <redirect-uri> <support-email>");
  console.error("  node oauth-client.mjs renew  <project-id>");
  process.exit(1);
}

const PROJECT_ID    = args[0];
const APP_NAME      = args[1];
const REDIRECT_URI  = args[2];
const SUPPORT_EMAIL = args[3];

if (!PROJECT_ID) { console.error("Missing project-id"); process.exit(1); }
if (MODE === "create" && (!APP_NAME || !REDIRECT_URI || !SUPPORT_EMAIL)) {
  console.error("create requires: <project-id> <app-name> <redirect-uri> <support-email>");
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, description) {
  for (const sel of selectors) {
    try { await page.locator(sel).first().click({ timeout: 5000 }); return true; } catch {}
  }
  throw new Error(`Could not find: ${description}`);
}

async function tryFill(page, selectors, value, description) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ timeout: 5000 });
      await loc.fill(value);
      return true;
    } catch {}
  }
  throw new Error(`Could not find input: ${description}`);
}

async function screenshot(page, name) {
  const p = IS_WIN ? path.join(os.tmpdir(), `gcp-oauth-${name}.png`) : `/tmp/gcp-oauth-${name}.png`;
  await page.screenshot({ path: p }).catch(() => {});
  console.error(`[screenshot] ${p}`);
}

// ─── Chrome launch ─────────────────────────────────────────────────────────────

const CHROME_PATH = findChrome();
console.error(`[boot] Chrome: ${CHROME_PATH}`);
console.error(`[boot] Profile: ${CHROME_PROFILE}`);

// Kill any Chrome already on that debug port
killChromeOnPort(DEBUG_PORT);
await new Promise(r => setTimeout(r, 1000));

// Launch Chrome with automation profile + debug port
const chromeArgs = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${CHROME_PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

console.error(`[boot] Launching Chrome on port ${DEBUG_PORT}...`);
if (IS_MAC) {
  // macOS: use 'open' so the window appears in the GUI session (works over SSH too)
  spawnSync("open", ["-a", "Google Chrome", "--args", ...chromeArgs], { encoding: "utf8" });
} else {
  // Windows / Linux: spawn directly, detach so it keeps running
  const proc = spawn(CHROME_PATH, chromeArgs, {
    detached: true,
    stdio: "ignore",
    ...(IS_WIN ? { windowsHide: false } : {}),
  });
  proc.unref();
}

// Wait for debug port to be ready (up to 25s)
console.error("[boot] Waiting for Chrome debug port...");
let portReady = false;
for (let i = 0; i < 25; i++) {
  await new Promise(r => setTimeout(r, 1000));
  if (isPortReady(DEBUG_PORT)) {
    portReady = true;
    console.error(`[boot] Ready after ${i + 1}s`);
    break;
  }
}
if (!portReady) throw new Error(`Chrome debug port ${DEBUG_PORT} not ready after 25s`);

// Connect Playwright via CDP
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const context  = browser.contexts()[0] ?? await browser.newContext();
const page     = await context.newPage();

// ─── Sign-in helper ────────────────────────────────────────────────────────────

async function ensureSignedIn(targetUrl) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (page.url().includes("accounts.google.com")) {
    console.error("");
    console.error("⚠️  Chrome session expired — sign-in required:");
    console.error("   → A Chrome window is now open.");
    console.error("   → Sign in with your Google Cloud account.");
    console.error("   → Waiting up to 3 minutes...");
    console.error("");
    await page.waitForURL(url => !url.toString().includes("accounts.google.com"), { timeout: 180000 });
    console.error("[auth] Signed in — re-navigating...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
  }
}

// ─── Consent screen (Google Auth Platform) — idempotente ───────────────────────
// Para proyectos nuevos en cuentas Gmail personales, la pantalla de consentimiento
// NO se puede crear por API (oauth-brands exige organización y está deprecada).
// Este wizard la crea por la UI nueva ("Google Auth Platform"): 4 pasos.
async function ensureConsentScreen() {
  await ensureSignedIn(`https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}`);
  await page.waitForTimeout(4000);

  /*
   * Deteccion POSITIVA, no por ausencia del boton.
   *
   * Antes esto decia "si no aparece Comenzar, ya esta configurada". Ausencia del boton no
   * prueba nada: la pagina puede no haber cargado todavia, el rotulo puede ser otro
   * ("Comenzar a usar", "Configurar"), o el asistente puede haber quedado a medias. En
   * cualquiera de esos casos reportaba exito y despues fallaban los pasos siguientes, que es
   * la mitad de la sensacion de "repite tareas y nunca termina".
   */
  const estado = await page.evaluate(() => {
    const boton = Array.from(document.querySelectorAll("button, a")).find(
      (e) => e.offsetWidth > 0 && /^(comenzar|get started|empezar)/i.test((e.textContent || "").trim()),
    );
    const texto = document.body.innerText || "";

    // Senales de que la pantalla YA existe y esta configurada.
    const configurada =
      /usuarios de prueba|test users|en producci|in production|publico|audience|^prueba$|^testing$/im.test(
        texto,
      );

    return { hayBoton: !!boton, configurada };
  });

  if (!estado.hayBoton && estado.configurada) {
    console.error("[consent] Pantalla de consentimiento ya configurada (verificado).");
    return { configurada: true, ejecutado: false };
  }

  if (!estado.hayBoton && !estado.configurada) {
    // Ni boton ni senales: no se puede afirmar nada. Se sigue igual y el que decide es
    // `diagnose`, que lee el estado real. Antes aca se mentia con un "ya configurada".
    console.error(
      "[consent] No pude determinar el estado de la pantalla de consentimiento. " +
        "Sigo igual; el diagnostico final lo confirma.",
    );
    return { configurada: null, ejecutado: false };
  }
  // Hay boton: se arranca el asistente.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button, a")).find(
      (e) => e.offsetWidth > 0 && /^(comenzar|get started|empezar)/i.test((e.textContent || "").trim()),
    );
    if (b) b.click();
  });

  console.error("[consent] Configurando pantalla de consentimiento (wizard de 4 pasos)...");
  await page.waitForTimeout(5000);
  await screenshot(page, "consent-wizard");

  const clickNext = async () => {
    await page.locator('button:has-text("Siguiente"), button:has-text("Next")').first()
      .click({ timeout: 5000 }).catch(() => {});
  };

  // Paso 1 — Información de la app: nombre + correo de soporte (cfc-select).
  await page.locator('input[formcontrolname="displayName"]').first().fill(APP_NAME).catch(() => {});
  await page.evaluate(() => {
    const el = document.querySelector('cfc-select[formcontrolname="userSupportEmail"]') || document.querySelector("cfc-select");
    if (el) el.click();
  });
  await page.waitForTimeout(1000);
  await page.evaluate((email) => {
    const o = Array.from(document.querySelectorAll("cfc-option, [role=option], mat-option")).filter((x) => x.offsetWidth > 0);
    (o.find((x) => x.textContent.includes(email)) || o[0])?.click();
  }, SUPPORT_EMAIL);
  await page.waitForTimeout(700);
  await clickNext();
  await page.waitForTimeout(2500);

  // Paso 2 — Público: "Usuarios externos".
  await page.locator('mat-radio-button:has-text("externos"), mat-radio-button:has-text("External")').first()
    .click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  await clickNext();
  await page.waitForTimeout(2500);

  // Paso 3 — Información de contacto (input de email, no el de búsqueda ni el nombre).
  await page.evaluate((email) => {
    const i = Array.from(document.querySelectorAll("input"))
      .find((x) => x.offsetWidth > 0 && x.type !== "search" && x.getAttribute("formcontrolname") !== "displayName");
    if (i) { i.focus(); i.value = email; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }
  }, SUPPORT_EMAIL);
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(700);
  await clickNext();
  await page.waitForTimeout(2500);

  // Paso 4 — Finalizar: aceptar la Política de Datos de Usuario + "Crear".
  await page.locator("mat-checkbox").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((e) => e.offsetWidth > 0 && !e.disabled && /^(crear|create)$/i.test(e.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(9000);
  await screenshot(page, "consent-created");

  // Verificacion: no se anuncia exito con solo haber apretado botones. Se vuelve al resumen
  // y se exige ver una senal real de que la pantalla existe.
  await page.goto(`https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const quedo = await page.evaluate(() => {
    const texto = document.body.innerText || "";
    return /usuarios de prueba|test users|en producci|in production|publico|audience/i.test(texto);
  });

  await screenshot(page, "consent-verificado");
  console.error(
    quedo
      ? "[consent] Pantalla de consentimiento creada y verificada."
      : "[consent] El asistente termino pero no pude confirmar el resultado. Corre 'gauth diagnose'.",
  );
  return { configurada: quedo ? true : null, ejecutado: true };
}

// ─── Shared: extract secret from existing client ───────────────────────────────

/**
 * Lee Client ID y secreto del dialogo que aparece despues de apretar "Crear".
 *
 * ESTE ES EL ARREGLO IMPORTANTE DEL FLUJO DE CREATE.
 * El secreto se muestra UNA sola vez: la propia consola avisa "Ya no podras ver ni descargar
 * el secreto una vez que cierres este dialogo". El codigo viejo leia el Client ID del dialogo
 * y lo cerraba sin mirar el secreto, y despues iba a crear un secreto NUEVO buscandolo en el
 * `innerHTML`. De ahi salia el secreto perdido (y un secreto de mas, que queda vivo en el
 * cliente sin que nadie lo use).
 *
 * Se lee con reintentos porque el dialogo se pinta de a poco, y de `innerText` (el texto
 * renderizado) y no de `innerHTML`, que trae el marcado y hace mas fragil el match.
 */
async function readCredentialsDialog(timeoutMs = 25000) {
  const inicio = Date.now();
  let clientId = "";
  let clientSecret = "";

  while (Date.now() - inicio < timeoutMs) {
    const r = await page.evaluate(() => {
      const texto = document.body.innerText || "";
      const id = texto.match(/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
      const secreto = texto.match(/(GOCSPX-[A-Za-z0-9_-]{10,})/);
      const mencionaSecreto = /secreto|secret/i.test(texto);
      return { id: id?.[1] ?? "", secreto: secreto?.[1] ?? "", mencionaSecreto };
    });

    if (r.id) clientId = r.id;
    if (r.secreto) {
      clientSecret = r.secreto;
      break;
    }
    if (clientId && !r.mencionaSecreto) break;

    await page.waitForTimeout(1000);
  }

  return { clientId, clientSecret };
}

/**
 * Extrae Client ID y secreto de un cliente que YA existe.
 *
 * Camino de respaldo del `create` y cuerpo del `renew`. Crea un secreto nuevo, porque Google
 * no vuelve a mostrar los existentes.
 *
 * TRES TRAMPAS DE LA PANTALLA DEL DETALLE (costaron varias corridas):
 *  1. Al abrir el detalle se monta un **dialogo de edicion** encima. Mientras esta abierto, la
 *     seccion de secretos NO esta en el DOM: hay que cerrarlo primero.
 *  2. El detalle es un modal con **scroll propio**: scrollear la ventana no revela nada.
 *  3. El secreto no aparece hasta apretar "Agregar secreto", y sale en OTRO dialogo.
 */
async function addAndExtractSecret() {
  await ensureSignedIn(`https://console.cloud.google.com/auth/clients?project=${PROJECT_ID}`);
  await page.waitForTimeout(4000);
  await screenshot(page, "clients-list");

  // Primer cliente de la lista: viene ordenada por fecha descendente.
  const clientHref = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"))
      .filter(a => /auth\/clients\/\d/.test(a.href));
    if (links[0]) { links[0].click(); return links[0].href; }
    return null;
  }).catch(() => null);
  console.error(`[secret] Cliente abierto: ${clientHref}`);
  await page.waitForTimeout(4000);
  await screenshot(page, "client-detail");

  let clientId = "";
  const urlMatch = page.url().match(/auth\/clients\/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
  if (urlMatch) clientId = urlMatch[1];
  if (!clientId) {
    const m = (await page.evaluate(() => document.body.innerText).catch(() => ""))
      .match(/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    if (m) clientId = m[1];
  }
  console.error(`[secret] Client ID: ${clientId?.substring(0, 50)}`);

  // Trampa 1: cerrar el dialogo de edicion para que aparezca la seccion de secretos.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(x =>
      /^Cancelar$/i.test((x.innerText || "").trim()),
    );
    if (b) b.click();
  }).catch(() => {});
  await page.waitForTimeout(2500);

  // Trampa 2: scrollear los contenedores con overflow, no la ventana.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }).catch(() => {});
  await page.waitForTimeout(1500);

  // Si ya hay un secreto a la vista, se usa ese en vez de crear otro.
  const yaVisible = (await page.evaluate(() => document.body.innerText || "")).match(/(GOCSPX-[A-Za-z0-9_-]{10,})/);
  if (yaVisible) {
    await screenshot(page, "secret-visible");
    return { clientId, clientSecret: yaVisible[1] };
  }

  // Trampa 3: hay que apretar "Agregar secreto" para que aparezca uno nuevo.
  const clickeado = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(x =>
      /^(Agregar secreto|Add secret|Crear secreto)$/i.test((x.innerText || "").trim()),
    );
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  }).catch(() => false);

  if (!clickeado) {
    console.error("[secret] No encontre el boton de agregar secreto.");
    await screenshot(page, "secret-sin-boton");
    return { clientId, clientSecret: "" };
  }

  await page.waitForTimeout(3500);
  await screenshot(page, "after-add-secret");

  const dialogo = await readCredentialsDialog(20000);
  return { clientId: clientId || dialogo.clientId, clientSecret: dialogo.clientSecret };
}

// ─── MODE: renew ──────────────────────────────────────────────────────────────

if (MODE === "renew") {
  try {
    console.error(`[renew] Project: ${PROJECT_ID}`);
    const creds = await addAndExtractSecret();
    if (!creds.clientId)     throw new Error("Could not find OAuth client. Check screenshot: gcp-oauth-clients-list.png");
    if (!creds.clientSecret) throw new Error("Could not extract secret. Check screenshot: gcp-oauth-after-add-secret.png");
    console.log(JSON.stringify(creds));
  } catch (err) {
    await screenshot(page, "error");
    console.error("ERROR:", err.message);
    process.exit(1);
  } finally {
    await context.close().catch(() => {});
    // Reopen Chrome to user's normal session
    if (IS_MAC) spawnSync("open", ["-a", "Google Chrome"], { encoding: "utf8" });
    else if (IS_WIN) spawnSync("start", ["chrome"], { shell: true });
  }
  process.exit(0);
}

// ─── MODE: create ─────────────────────────────────────────────────────────────

try {
  console.error(`[create] Project: ${PROJECT_ID}, App: ${APP_NAME}`);

  // Asegura la pantalla de consentimiento (idempotente) ANTES de crear el cliente.
  await ensureConsentScreen();

  // Ir al formulario de creación de cliente OAuth.
  console.error("[create] Navigating to create client...");
  await page.goto(
    `https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}`,
    { waitUntil: "domcontentloaded", timeout: 30000 }
  );
  await page.waitForTimeout(4000);
  await screenshot(page, "step2-create");

  // Wait for client creation form
  await page.waitForSelector("cfc-select, mat-select, input[formcontrolname=displayName]", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Select "Web application"
  if (await page.locator("cfc-select").first().isVisible({ timeout: 3000 }).catch(() => false)) {
    const cur = await page.evaluate(() => document.querySelector("cfc-select")?.textContent?.trim() ?? "").catch(() => "");
    if (!/web/i.test(cur)) {
      await page.locator("cfc-select").first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const web = Array.from(document.querySelectorAll("[role=option], mat-option")).find(o => /aplicaci.*web|web application/i.test(o.textContent));
        if (web) web.click();
      }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // Fill client name
  await tryFill(page, [
    'input[formcontrolname="displayName"]', 'input[formcontrolname="name"]',
    'input[aria-label*="name" i]', 'input[aria-label*="nombre" i]',
    'input[placeholder*="name" i]', 'mat-form-field input[type="text"]',
  ], APP_NAME, "client name");

  // Add redirect URI (2nd "Agregar URI" button = redirect URIs section)
  const uriCount = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"))
      .filter(b => b.offsetWidth > 0 && /agregar uri|add uri/i.test(b.textContent.trim()));
    (btns[1] ?? btns[0])?.click();
    return btns.length;
  }).catch(() => 0);
  console.error(`[create] Add URI buttons: ${uriCount}`);
  await page.waitForTimeout(800);

  const uriInput = page.locator('input[formcontrolname="uri"], input[placeholder*="https://" i]').last();
  if (await uriInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await uriInput.fill(REDIRECT_URI);
  } else {
    await page.evaluate(uri => {
      const inp = Array.from(document.querySelectorAll("input")).find(el => el.placeholder.includes("https://") && el.offsetWidth > 0);
      if (inp) { inp.focus(); inp.value = uri; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
    }, REDIRECT_URI).catch(() => {});
  }
  await page.waitForTimeout(300);

  // Submit
  console.error("[create] Submitting...");
  await screenshot(page, "before-submit");
  await tryClick(page, [
    'button[type="submit"]:has-text("Crear")', 'button[type="submit"]:has-text("Create")',
    'button:has-text("CREAR")', 'button:has-text("Crear"):not(:has-text("credenciales"))',
  ], "Create button");
  await page.waitForTimeout(3000);
  await screenshot(page, "after-submit");

  // El dialogo que sigue a "Crear" trae el Client ID **y el secreto**, y el secreto se muestra
  // una sola vez. Se lee ANTES de cerrar: el codigo viejo lo cerraba sin mirarlo y despues
  // creaba un secreto de mas para poder leerlo.
  console.error("[create] Leyendo credenciales del dialogo...");
  const dialogo = await readCredentialsDialog();
  let clientId = dialogo.clientId;
  if (clientId) console.error(`[create] Client ID: ${clientId.substring(0, 50)}`);
  if (dialogo.clientSecret) console.error("[create] Secreto capturado del dialogo.");

  // Recien ahora se cierra.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => /aceptar|accept|ok|cerrar|close/i.test(b.textContent.trim()));
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(1500);

  // Solo si el dialogo no mostro el secreto se recurre a generar uno nuevo.
  let clientSecret = dialogo.clientSecret;
  if (!clientSecret) {
    console.error("[create] El dialogo no mostro el secreto; se genera uno nuevo.");
    const creds = await addAndExtractSecret();
    clientSecret = creds.clientSecret;
    if (!clientId) clientId = creds.clientId;
  }

  if (!clientId)     throw new Error("No pude obtener el Client ID. Revisa la captura gcp-oauth-error.png");
  if (!clientSecret) throw new Error("No pude obtener el secreto. Revisa la captura gcp-oauth-after-add-secret.png");

  console.log(JSON.stringify({ clientId, clientSecret }));

} catch (err) {
  await screenshot(page, "error");
  console.error("ERROR:", err.message);
  process.exit(1);
} finally {
  await context.close().catch(() => {});
  if (IS_MAC) spawnSync("open", ["-a", "Google Chrome"], { encoding: "utf8" });
  else if (IS_WIN) spawnSync("start", ["chrome"], { shell: true });
}
