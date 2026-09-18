/**
 * Ciclo de vida del Chrome de automatizacion. Windows / macOS / Linux.
 *
 * POR QUE EXISTE ESTE ARCHIVO
 * La Google Cloud Console no expone por API ni por gcloud las pantallas de OAuth
 * (clientes, secreto, usuarios de prueba, estado de publicacion, marca). La unica via
 * es el navegador. Y para eso hay que manejar bien un Chrome con puerto de depuracion.
 *
 * TRAMPAS QUE CUESTAN TIEMPO (no borrar, ya nos mordieron):
 *
 * 1. `--user-data-dir` PROPIO ES OBLIGATORIO.
 *    Si se lanza sin el y el usuario ya tiene Chrome abierto, el proceso nuevo le pasa
 *    los argumentos a la instancia existente y MUERE. La instancia existente ignora
 *    `--remote-debugging-port`, asi que el puerto nunca abre y el script se cuelga
 *    esperando algo que jamas va a pasar.
 *
 * 2. NO LANCES UN CHROME POR PANTALLA.
 *    Reusa la instancia viva. Lanzar y matar en cada paso hacia que en la tercera
 *    pantalla la conexion CDP fallara con ECONNREFUSED.
 *
 * 3. NO CIERRES LA ULTIMA PESTANA.
 *    Deja la instancia viva pero incapaz de abrir otra:
 *    "Protocol error (Target.createTarget): Failed to open a new tab".
 *    Por eso `close()` navega a about:blank en vez de cerrar la pestana.
 */

import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const DEFAULT_PORT = 9222;

/** Perfil dedicado. NO uses tu perfil real de Chrome. */
export function defaultProfile() {
  return (
    process.env.GOOGLE_OAUTH_PROFILE ??
    path.join(os.homedir(), ".google-oauth-cli", "chrome-profile")
  );
}

const WIN_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const LINUX_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** Devuelve la ruta del navegador o lanza. Permite forzar con BROWSER_PATH. */
export function findBrowser(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`BROWSER_PATH no existe: ${explicit}`);
    return explicit;
  }
  if (process.env.BROWSER_PATH) return findBrowser(process.env.BROWSER_PATH);

  if (process.platform === "win32") {
    const hit = WIN_CANDIDATES.find((c) => fs.existsSync(c));
    if (hit) return hit;
    throw new Error("No encontre Chrome ni Edge. Instalalo o pasa BROWSER_PATH=<ruta>.");
  }

  if (process.platform === "darwin") {
    const hit = MAC_CANDIDATES.find((c) => fs.existsSync(c));
    if (hit) return hit;
    throw new Error("No encontre Chrome en /Applications. Pasa BROWSER_PATH=<ruta>.");
  }

  for (const bin of LINUX_BINS) {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error("No encontre Chrome/Chromium. Instalalo o pasa BROWSER_PATH=<ruta>.");
}

/** true si hay un Chrome escuchando en el puerto de depuracion. */
export async function portAlive(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Mata el proceso que ocupa el puerto de depuracion.
 * Necesario porque la instancia se degrada y hay que reiniciarla limpia.
 */
export function killOnPort(port = DEFAULT_PORT) {
  let pids = [];

  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    pids = (r.stdout ?? "")
      .split("\n")
      .filter((l) => l.includes(`:${port}`) && /LISTENING/i.test(l))
      .map((l) => l.trim().split(/\s+/).pop())
      .filter((p) => p && /^\d+$/.test(p));
    for (const pid of new Set(pids)) {
      spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
    }
  } else {
    const r = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    pids = (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) spawnSync("kill", ["-9", pid], { stdio: "ignore" });
  }

  return [...new Set(pids)].length;
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (await portAlive(port)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Chrome no abrio el puerto de depuracion ${port} en ${timeoutMs}ms.\n` +
          `Causa habitual: ya tenias Chrome abierto con ese perfil. Corre 'gauth kill' y reintenta.`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Lanza Chrome con depuracion remota, o reusa el que ya esta.
 *
 * Si el puerto ya responde NO lanza nada: la sesion (cookies) vive en el perfil, asi
 * que reusar el proceso es mas rapido y evita el problema de la trampa #1.
 */
export async function ensureChrome({ port = DEFAULT_PORT, profile = defaultProfile() } = {}) {
  if (await portAlive(port)) return { launched: false, port, profile };

  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ];

  const child = spawn(findBrowser(), args, { detached: true, stdio: "ignore" });
  child.unref();

  await waitForPort(port, 30000);
  return { launched: true, port, profile };
}

/** Conectar por CDP, con un reintento si la instancia quedo en mal estado. */
export async function attach({ port = DEFAULT_PORT, profile = defaultProfile() } = {}) {
  await ensureChrome({ port, profile });

  const grab = async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());

    // Dejar una sola pestana. Cerrar el resto (no la ultima: trampa #3).
    const pages = context.pages();
    for (const p of pages.slice(1)) {
      try {
        await p.close();
      } catch {
        /* ya estaba cerrada */
      }
    }

    const page = pages[0] ?? (await context.newPage());
    page.setDefaultTimeout(30000);
    return page;
  };

  try {
    return await grab();
  } catch {
    killOnPort(port);
    await new Promise((r) => setTimeout(r, 1500));
    await ensureChrome({ port, profile });
    return await grab();
  }
}

/**
 * Abre una URL en el Chrome automatizado y devuelve la pagina lista para usar.
 *
 * `settleMs` reemplaza a `waitUntil: "networkidle"`, que en la consola de Google
 * NUNCA dispara: es una SPA con conexiones permanentes.
 */
export async function openPage(url, { port = DEFAULT_PORT, profile = defaultProfile(), settleMs = 7000 } = {}) {
  const page = await attach({ port, profile });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(settleMs);

  return {
    page,
    async close() {
      try {
        await page.goto("about:blank", { timeout: 15000 });
      } catch {
        /* da igual: el proceso queda vivo para el proximo comando */
      }
    },
  };
}
