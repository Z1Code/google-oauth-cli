#!/usr/bin/env node
/**
 * google-oauth-cli — Google OAuth 2.0 sin tocar la consola.
 *
 * La Google Cloud Console es la unica via para administrar la pantalla de consentimiento
 * OAuth, y no tiene API. Este CLI la maneja con Playwright: crea el cliente, rota
 * secretos, carga la marca, publica la app y administra usuarios de prueba.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import os from "node:os";

import {
  defaultProfile,
  killOnPort,
  ensureChrome,
  openPage,
  DEFAULT_PORT,
} from "./lib/chrome.mjs";
import {
  authUrl,
  diagnose,
  getPublishStatus,
  getBranding,
  listClients,
  listTestUsers,
  addTestUsers,
  removeTestUsers,
  fillBranding,
  publishApp,
} from "./lib/consent.mjs";
import { ensureProject } from "./lib/ensure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── Argumentos ───────────────────────────────────────────────────────────────

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [rawK, inlineV] = a.slice(2).split("=");
      const k = camel(rawK);
      if (inlineV !== undefined) flags[k] = inlineV;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

const { flags, rest } = parseArgs(process.argv.slice(2));
const [command, sub] = rest;

// ─── Salida ───────────────────────────────────────────────────────────────────

const C = process.stdout.isTTY
  ? { ok: "\x1b[32m", bad: "\x1b[31m", warn: "\x1b[33m", dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m" }
  : { ok: "", bad: "", warn: "", dim: "", b: "", r: "" };

function emit(payload, { human } = {}) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (human) {
    human(payload);
  } else {
    console.log(payload);
  }
  process.exit(payload?.ok === false ? 1 : 0);
}

function log(msg) {
  if (!flags.json) console.error(msg);
}

const ctx = () => ({
  project: flags.project ?? process.env.GOOGLE_OAUTH_PROJECT,
  port: flags.port ? Number(flags.port) : DEFAULT_PORT,
  profile: flags.profile ?? defaultProfile(),
  settleMs: flags.settle ? Number(flags.settle) : undefined,
});

function requireProject() {
  const { project } = ctx();
  if (!project) {
    console.error(
      `Falta el proyecto.\n\n  gauth ${command} --project <project-id>\n\n` +
        `O exportá GOOGLE_OAUTH_PROJECT=<project-id>.\n` +
        `Para listar tus proyectos: gcloud projects list`,
    );
    process.exit(2);
  }
  return project;
}

// ─── Ayuda ────────────────────────────────────────────────────────────────────

const HELP = `
${C.b}google-oauth-cli${C.r} — Google OAuth 2.0 sin tocar la consola.

${C.b}USO${C.r}
  gauth <comando> [opciones]

${C.b}COMANDOS${C.r}
  ${C.b}ensure${C.r}       Deja el login FUNCIONANDO: crea lo que falte y verifica. Empeza por aca.
  ${C.b}diagnose${C.r}     Que falta para entrar y que falta para publicar
  ${C.b}create${C.r}       Crea un cliente OAuth Web (Client ID + secret)
  ${C.b}clients${C.r}      Lista los clientes OAuth del proyecto
  ${C.b}renew${C.r}        Agrega un secret nuevo a un cliente existente
  ${C.b}status${C.r}       Solo el estado de publicacion
  ${C.b}branding${C.r}     Carga los datos de la marca (web, privacidad, terminos, contacto)
  ${C.b}publish${C.r}      Publica la app para salir del limite de 100 usuarios
  ${C.b}test-users${C.r}   list | add | remove  — usuarios de prueba
  ${C.b}open${C.r}         Abre una pantalla de la consola en el Chrome automatizado
  ${C.b}kill${C.r}         Mata el Chrome de automatizacion si quedo trabado

${C.b}OPCIONES COMUNES${C.r}
  --project <id>     Proyecto de GCP. Tambien GOOGLE_OAUTH_PROJECT
  --json             Salida JSON (para scripts y agentes)
  --port <n>         Puerto de depuracion (default ${DEFAULT_PORT})
  --profile <dir>    Perfil de Chrome (default ${defaultProfile()})
  --settle <ms>      Espera extra tras cargar cada pantalla

${C.b}CREAR UN CLIENTE${C.r}
  gauth create --project <id> --name "Mi App" \\
               --redirect https://midominio.com/api/auth/callback/google \\
               --email soporte@midominio.com

${C.b}PASOS TIPICOS${C.r}
  ${C.b}gauth ensure${C.r} --project <id> --name "Mi App" \\
              --redirect https://x.com/api/auth/callback/google \\
              --email soporte@x.com --emails "cliente@x.com"
  ${C.dim}# idempotente: repetilo las veces que quieras, solo hace lo que falta${C.r}

  gauth diagnose --project <id>          ${C.dim}# que falta para que el login funcione${C.r}
  gauth test-users add --project <id> --emails "a@x.com,b@y.com"
  gauth branding --project <id> --homepage https://x.com \\
                 --privacy https://x.com/privacy --terms https://x.com/terms \\
                 --contact soporte@x.com
  gauth publish --project <id>

${C.b}VARIABLES${C.r}
  GOOGLE_OAUTH_PROJECT   Proyecto por defecto
  GOOGLE_OAUTH_PROFILE   Perfil de Chrome a usar
  BROWSER_PATH           Ruta a Chrome/Edge si no se detecta solo

${C.dim}La primera vez Chrome abre con un perfil dedicado: inicia sesion una vez y la
sesion queda guardada. Ese perfil contiene cookies de tu cuenta: NO lo subas a git.${C.r}
`;

// ─── Comandos ─────────────────────────────────────────────────────────────────

async function cmdCreate() {
  const project = flags.project ?? rest[1];
  const name = flags.name ?? flags.appName ?? rest[2];
  const redirect = flags.redirect ?? flags.redirectUri ?? rest[3];
  const email = flags.email ?? flags.supportEmail ?? rest[4];

  if (!project || !name || !redirect || !email) {
    console.error(
      `Faltan datos para crear el cliente.\n\n` +
        `  gauth create --project <id> --name "<app>" \\\n` +
        `               --redirect <https://dominio/api/auth/callback/google> \\\n` +
        `               --email <soporte@dominio>\n`,
    );
    process.exit(2);
  }

  return runLegacy(["create", project, name, redirect, email]);
}

async function cmdRenew() {
  const project = requireProject();
  return runLegacy(["renew", project]);
}

/**
 * Delega en el script original (create/renew), que ya esta probado contra la consola.
 * Se ejecuta aparte a proposito: ese script hace efectos en el arranque, importarlo
 * dispararia el flujo entero.
 */
function runLegacy(args) {
  const script = path.join(HERE, "lib", "oauth-client.mjs");
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: flags.json ? ["inherit", "pipe", "inherit"] : "inherit",
  });

  if (res.error) {
    console.error(`No pude ejecutar ${script}: ${res.error.message}`);
    process.exit(1);
  }

  if (flags.json) {
    // El script imprime un unico JSON en stdout: se reenvia tal cual para no romper
    // el contrato de quien lo consuma.
    const raw = (res.stdout ?? "").trim();
    try {
      const parsed = JSON.parse(raw);
      emit({ ok: true, ...parsed });
    } catch {
      emit({ ok: false, raw, error: "La salida del script no fue JSON valido." });
    }
  }

  process.exit(res.status ?? 1);
}

async function cmdStatus() {
  const project = requireProject();
  const payload = await getPublishStatus(ctx());
  emit({ ok: true, ...payload }, {
    human: (p) => {
      const color = p.publishingStatus === "production" ? C.ok : C.warn;
      console.log(`\nProyecto:   ${C.b}${p.project}${C.r}`);
      console.log(`Estado:     ${color}${p.statusLabel ?? p.publishingStatus}${C.r}`);
      if (p.testUserLimit) console.log(`Usuarios:   ${p.testUserLimit}`);
      console.log(`Publicable: ${p.publishEnabled ? C.ok + "si" : C.warn + "no"}${C.r}`);
      if (p.publishMessage) console.log(`\n${C.warn}${p.publishMessage}${C.r}`);
      console.log();
    },
  });
}

async function cmdDiagnose() {
  const project = requireProject();
  const payload = await diagnose({ ...ctx(), redirect: flags.redirect ?? flags.redirectUri });

  emit(payload, {
    human: (p) => {
      console.log(`\n${C.b}${p.project}${C.r}`);
      console.log(
        `Estado: ${p.publish.publishingStatus === "production" ? C.ok + "Produccion" : C.warn + "Prueba"}${C.r}` +
          `   Usuarios de prueba: ${p.testUsersCount}` +
          `   Clientes OAuth: ${p.clients.length}`,
      );
      if (!p.clients.length) {
        console.log(`\n${C.bad}No hay ningun cliente OAuth.${C.r} Sin Client ID no hay login posible.`);
      }

      const deLogin = p.blockers.filter((b) => b.level === "login");
      const dePublicar = p.blockers.filter((b) => b.level !== "login");

      if (!deLogin.length) {
        console.log(`\n${C.ok}El login funciona: no falta nada para que alguien pueda entrar.${C.r}`);
      } else {
        console.log(`\n${C.bad}El login NO funciona todavia${C.r}`);
        for (const b of deLogin) {
          console.log(`\n  ${C.bad}${b.code}${C.r}`);
          console.log(`  ${b.detail}`);
          console.log(`  ${C.dim}→ ${b.fix}${C.r}`);
        }
      }

      if (dePublicar.length) {
        console.log(`\n${C.b}Para publicar (el login no depende de esto)${C.r}`);
        for (const b of dePublicar) {
          console.log(`  ${C.warn}!${C.r} ${b.code}`);
          console.log(`    ${C.dim}${b.detail}${C.r}`);
          console.log(`    ${C.dim}→ ${b.fix}${C.r}`);
        }
      }

      if (deLogin.length || dePublicar.length) {
        console.log(`\n${C.dim}Atajo: 'gauth ensure' resuelve lo del login solo.${C.r}`);
      }
      console.log();
    },
  });
}

async function cmdBranding() {
  const project = requireProject();
  const payload = await fillBranding({
    ...ctx(),
    homepage: flags.homepage,
    privacy: flags.privacy,
    terms: flags.terms,
    contact: flags.contact ?? flags.email,
  });

  if (!flags.homepage && !flags.privacy && !flags.terms && !flags.contact && !flags.email) {
    const current = await getBranding(ctx());
    emit(
      { ok: true, ...current },
      {
        human: (p) => {
          console.log(`\n${C.b}Marca de ${p.project}${C.r}\n`);
          for (const f of p.fields) {
            console.log(`  ${f.empty ? C.warn + "VACIO" + C.r : C.ok + "ok   " + C.r}  ${f.label}`);
            if (f.value) console.log(`         ${C.dim}${f.value}${C.r}`);
          }
          console.log(`\n${C.b}Dominios autorizados${C.r}`);
          p.authorizedDomains.forEach((d) => console.log(`  ${d}`));
          console.log();
        },
      },
    );
  }

  emit(payload, {
    human: (p) => {
      for (const w of p.written ?? []) {
        console.log(`  ${w.ok ? C.ok + "OK   " + C.r : C.bad + "FALLO" + C.r}  ${w.field}`);
      }
      for (const s of p.persisted ?? []) {
        console.log(`  ${s.persisted ? C.ok + "guardado" + C.r : C.bad + "NO persistio" + C.r}  ${s.field}`);
      }
      if (p.error) console.log(`\n${C.warn}${p.error}${C.r}`);
      console.log();
    },
  });
}

async function cmdPublish() {
  const project = requireProject();
  const payload = await publishApp(ctx());
  emit(payload, {
    human: (p) => {
      if (p.ok) console.log(`\n${C.ok}${p.note}${C.r}\n`);
      else if (p.blocked) {
        console.log(`\n${C.warn}${p.error}${C.r}`);
        if (p.message) console.log(`${p.message}`);
        console.log(`${C.dim}${p.hint}${C.r}\n`);
      } else console.log(`\n${C.bad}${p.error}${C.r}\n`);
    },
  });
}

async function cmdTestUsers() {
  const project = requireProject();
  const emails = flags.emails ?? flags.email;

  if (sub === "list" || !sub) {
    const users = await listTestUsers(ctx());
    emit({ ok: true, project, testUsers: users, count: users.length }, {
      human: (p) => {
        console.log(`\n${C.b}Usuarios de prueba de ${p.project}${C.r} (${p.count})\n`);
        p.testUsers.forEach((u) => console.log(`  ${u}`));
        if (!p.count) {
          console.log(`  ${C.warn}(ninguno)${C.r}`);
          console.log(
            `\n  ${C.warn}Una app en Prueba sin usuarios de prueba rechaza TODOS los logins,${C.r}\n` +
              `  ${C.warn}y Google no llega a tocar tu app: no vas a ver nada en tus logs.${C.r}`,
          );
        }
        console.log();
      },
    });
  }

  if (!emails) {
    console.error(`Falta --emails\n\n  gauth test-users ${sub} --project <id> --emails "a@x.com,b@y.com"\n`);
    process.exit(2);
  }

  if (sub === "add") {
    const payload = await addTestUsers({ ...ctx(), emails });
    emit(payload, {
      human: (p) => {
        p.added?.forEach((e) => console.log(`  ${C.ok}agregado${C.r}  ${e}`));
        p.missing?.forEach((e) => console.log(`  ${C.bad}no se agrego${C.r}  ${e}`));
        if (p.error) console.log(`\n${C.bad}${p.error}${C.r}`);
        console.log();
      },
    });
  }

  if (sub === "remove") {
    const payload = await removeTestUsers({ ...ctx(), emails });
    emit({ ok: payload.stillPresent.length === 0, ...payload }, {
      human: (p) => {
        p.removed?.forEach((e) => console.log(`  ${C.ok}quitado${C.r}  ${e}`));
        p.stillPresent?.forEach((e) => console.log(`  ${C.bad}sigue estando${C.r}  ${e}`));
        console.log();
      },
    });
  }

  console.error(`Subcomando desconocido: ${sub}. Usá list, add o remove.`);
  process.exit(2);
}

async function cmdOpen() {
  const project = requireProject();
  const screen = flags.screen ?? sub ?? "overview";
  const { page, close } = await openPage(authUrl(screen, project), ctx());
  log(`Chrome abierto en /auth/${screen}. Sesion guardada en ${ctx().profile}`);
  // No se cierra: la idea es que la mires y sigas a mano.
  void page;
  void close;
}

async function cmdKill() {
  const n = killOnPort(ctx().port);
  emit({ ok: true, killed: n, port: ctx().port }, {
    human: () => console.log(n ? `Chrome de automatizacion detenido (${n} proceso/s).` : "No habia nada corriendo."),
  });
}

/**
 * Crea un cliente OAuth y devuelve `{clientId, clientSecret}`.
 *
 * Se ejecuta como proceso aparte a proposito: `lib/oauth-client.mjs` arranca el flujo al
 * importarse. A diferencia de `runLegacy`, no corta el proceso: lo usa `ensure`, que tiene
 * que seguir con los pasos siguientes.
 */
function crearCliente({ project, name, redirect, email }) {
  const script = path.join(HERE, "lib", "oauth-client.mjs");
  const res = spawnSync(process.execPath, [script, "create", project, name, redirect, email], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });

  if (res.error) throw new Error(`No pude ejecutar ${script}: ${res.error.message}`);

  const raw = (res.stdout ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`La creacion no devolvio JSON valido: ${raw.slice(0, 300)}`);
  }
}

/** Deja el login funcionando. Ver `lib/ensure.mjs` para el por que del bucle. */
async function cmdEnsure() {
  const project = requireProject();

  const payload = await ensureProject({
    ...ctx(),
    project,
    name: flags.name ?? flags.appName,
    redirect: flags.redirect ?? flags.redirectUri,
    email: flags.email ?? flags.supportEmail,
    emails: flags.emails ?? flags.email,
    crearCliente,
  });

  emit(payload, {
    human: (p) => {
      console.log(`\n${C.b}${p.project}${C.r} — ${p.vueltas} vuelta(s)\n`);

      for (const paso of p.pasos ?? []) {
        const r = paso.resultado ?? {};
        const bien = r.ok !== false && !r.error;
        console.log(`  ${bien ? C.ok + "OK   " + C.r : C.bad + "FALLO" + C.r}  ${paso.accion}`);
        if (r.error) console.log(`        ${C.dim}${r.error}${C.r}`);
        if (r.countBefore !== undefined && r.countAfter !== undefined) {
          console.log(`        ${C.dim}usuarios de prueba: ${r.countBefore} -> ${r.countAfter}${C.r}`);
        }
      }

      if (p.ok) {
        console.log(`\n${C.ok}LISTO${C.r} — ${p.motivo}`);
        if (p.credenciales) {
          console.log(`\n  ${C.b}AUTH_GOOGLE_ID${C.r}=${p.credenciales.clientId}`);
          console.log(`  ${C.b}AUTH_GOOGLE_SECRET${C.r}=${p.credenciales.clientSecret}`);
        }
        console.log(`  Usuarios de prueba: ${p.usuariosDePrueba}`);

        if (p.pendienteParaPublicar?.length) {
          console.log(`\n${C.b}El login ya funciona. Para PUBLICAR todavia falta:${C.r}`);
          for (const b of p.pendienteParaPublicar) {
            console.log(`  ${C.warn}!${C.r} ${b.code}: ${b.fix}`);
          }
        }
        console.log();
        return;
      }

      console.log(`\n${C.bad}TRABADO${C.r} — ${p.motivo}`);
      for (const b of p.bloqueos ?? []) console.log(`  ${C.warn}!${C.r} ${b.code}: ${b.detail}`);
      if (p.faltanDatos?.length) console.log(`\n  Pasale: ${p.faltanDatos.join(" ")}`);
      console.log();
    },
  });
}

/** Lista los clientes OAuth. Sin cliente no hay login posible. */
async function cmdClients() {
  const project = requireProject();
  const clients = await listClients(ctx());

  emit({ ok: true, project, clients, count: clients.length }, {
    human: (p) => {
      console.log(`\n${C.b}Clientes OAuth de ${p.project}${C.r} (${p.count})\n`);
      if (!p.count) {
        console.log(`  ${C.warn}(ninguno)${C.r}  Sin cliente no hay Client ID con el que entrar.`);
        console.log(`  ${C.dim}Crea uno con: gauth create --project ${p.project} ...${C.r}\n`);
        return;
      }
      for (const c of p.clients) console.log(`  ${c.clientId}\n    ${C.dim}${c.nombre}${C.r}`);
      console.log();
    },
  });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const COMMANDS = {
  ensure: cmdEnsure,
  create: cmdCreate,
  renew: cmdRenew,
  diagnose: cmdDiagnose,
  clients: cmdClients,
  status: cmdStatus,
  branding: cmdBranding,
  publish: cmdPublish,
  "test-users": cmdTestUsers,
  testUsers: cmdTestUsers,
  open: cmdOpen,
  kill: cmdKill,
  help: () => {
    console.log(HELP);
    process.exit(0);
  },
};

process.on("unhandledRejection", (err) => {
  console.error(`\n${C.bad}Error:${C.r} ${err?.message ?? err}\n`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});

if (!command || flags.help || command === "help" || command === "--help") {
  console.log(HELP);
  process.exit(command ? 0 : 2);
}

const handler = COMMANDS[command];

if (!handler) {
  console.error(`Comando desconocido: ${command}\n`);
  console.log(HELP);
  process.exit(2);
}

// `kill` apunta a un Chrome que puede estar trabado: arrancar uno para despues
// matarlo no tiene sentido, y si ya hay uno vivo lo estaria reviviendo.
if (!["kill", "help"].includes(command)) {
  try {
    await ensureChrome({ port: ctx().port, profile: ctx().profile });
  } catch (err) {
    console.error(
      `\n${C.bad}No pude preparar Chrome.${C.r}\n${err.message}\n\n` +
        `Probalo a mano:\n  gauth kill\n  gauth ${command} --project <id>\n`,
    );
    process.exit(1);
  }
}

await handler();
