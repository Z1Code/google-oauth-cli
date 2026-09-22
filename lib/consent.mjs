/**
 * Estado y configuracion de la pantalla de consentimiento OAuth.
 *
 * POR QUE NO ALCANZA GCLOUD
 * `gcloud` maneja proyectos y APIs, pero la pantalla de consentimiento OAuth no la
 * expone: publicar la app, cargar la marca y administrar usuarios de prueba solo se
 * pueden tocar desde la consola web. Estos comandos automatizan exactamente eso.
 *
 * LAS DOS TRAMPAS QUE ROMPEN PROYECTOS EN SILENCIO:
 *
 * 1. Una app en estado "Prueba" con CERO usuarios de prueba rechaza a TODOS.
 *    Google no llega a tocar tu app, asi que no vas a ver nada en tus logs: el login
 *    simplemente "no funciona". Si acabas de crear el cliente, agrega usuarios.
 *
 * 2. Para PUBLICAR la app Google exige que la marca este completa, incluidos los
 *    enlaces a Politica de Privacidad y Condiciones del Servicio. Si esas paginas no
 *    existen en tu sitio, "Publicar app" queda deshabilitado y el guardado no persiste
 *    aunque el boton "Guardar" se habilite.
 */

import { openPage } from "./chrome.mjs";
import {
  bodyText,
  lines,
  buttons,
  clickByText,
  waitForTextGone,
  waitForText,
  reload,
  fields,
  setField,
  typeIntoField,
} from "./console.mjs";

/** URL de una pantalla de Google Auth Platform. */
export function authUrl(screen, project) {
  return `https://console.cloud.google.com/auth/${screen}?project=${encodeURIComponent(project)}`;
}

const SCREENS = {
  overview: "overview",
  branding: "branding",
  audience: "audience",
  clients: "clients",
  dataAccess: "data-access",
};

/** Textos de la consola segun el idioma de la cuenta. */
const T = {
  test: [/^Prueba$/i, /^Testing$/i],
  production: [/en producci/i, /^In production/i],
  publishButton: /^(Publicar app|Publish app)$/i,
  saveButton: /^(Guardar|Save)$/i,
  addUsersButton: /^(Add users|Agregar usuarios|A\u00f1adir usuarios)$/i,
};

function matchAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

/**
 * Saca el numero de usuarios de la linea que escribe la propia consola:
 *   "1 usuario (1 de prueba, 0 de otro tipo)/limite de usuarios de 100"
 *
 * OJO CON EL SINGULAR: con un solo usuario la consola dice "1 usuario", no "1 usuarios".
 * Una regex que solo acepte el plural devuelve null justo en el caso mas comun (un proyecto
 * recien creado con un unico usuario de prueba), y sin conteo no se puede afirmar nada.
 */
export function parseUserCount(line) {
  const m = String(line ?? "").match(/(\d+)\s*(?:usuario|usuarios|user|users)\s*\(/i);
  return m ? Number(m[1]) : null;
}

// ─── Estado ───────────────────────────────────────────────────────────────────

/**
 * Lee el estado de publicacion de la app.
 * Devuelve `{ publishingStatus, testUserLimit, publishEnabled, publishMessage }`.
 */
export async function getPublishStatus({ project, port, profile, settleMs } = {}) {
  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });
  const text = await lines(page);
  const btns = await buttons(page);

  const statusLine = text.find((l) => matchAny(l, [...T.test, ...T.production])) ?? null;
  // La linea util es la que trae el numero: "1 usuario (1 de prueba, ...)/limite de 100".
  // Ojo con el SINGULAR ("1 usuario", no "1 usuarios"): ver `parseUserCount`.
  const limitLine = text.find((l) => /\d+\s*(usuario|usuarios|user|users)\s*\(/i.test(l)) ?? null;

  const publish = btns.find((b) => T.publishButton.test(b.text));
  // El motivo del bloqueo esta justo despues del boton deshabilitado. Solo esa linea:
  // sumar la siguiente mete el titulo de la seccion siguiente en el mensaje.
  const idx = text.findIndex((l) => /debes completar|must complete|complete the/i.test(l));
  const publishMessage = idx >= 0 ? text[idx] : null;

  const result = {
    project,
    publishingStatus: matchAny(statusLine ?? "", T.production) ? "production" : "testing",
    statusLabel: statusLine,
    testUserLimit: limitLine,
    publishEnabled: publish ? !publish.disabled : null,
    publishMessage,
  };

  await close();
  return result;
}

/**
 * Lee la pantalla "Publico" (audience): cuantos usuarios de prueba hay y quien.
 *
 * POR QUE NO SE CUENTAN LOS CORREOS DEL innerText
 * El metodo viejo raspaba TODOS los correos de la pagina con una regex. Esta pantalla
 * muestra otros correos que NO son usuarios de prueba (el de la cuenta con la que estas
 * logueado, el contacto del desarrollador), asi que el conteo salia inflado. Con un correo
 * de mas el diagnostico daba por bueno el bloqueo "NO_TEST_USERS" y avisaba "el login
 * deberia funcionar" cuando en realidad no entraba nadie. Es el peor error posible aca:
 * falso "esta listo".
 *
 * La fuente autoritativa es la linea que la consola escribe sola, de la que sale `count`.
 * La lista de correos es secundaria (para mostrar); si no cuadra con el conteo se marca
 * `countReliable` en vez de mentir.
 */
export async function readAudience({ project, port, profile, settleMs } = {}) {
  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });
  const text = await bodyText(page);

  const limitLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\d+\s*(usuario|usuarios|user|users)\s*\(/i.test(l)) ?? null;
  const count = parseUserCount(limitLine);

  // Los correos se buscan primero dentro de la tabla/lista de usuarios, que es lo unico que
  // son usuarios de prueba de verdad.
  const emails = await page.evaluate(() => {
    const RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const leer = (root) => [...new Set((root.innerText || "").match(RE) ?? [])];

    for (const c of document.querySelectorAll(
      "table, [role=table], ma-table, cfc-user-list, mat-list, [role=list]",
    )) {
      const found = leer(c);
      if (found.length) return found;
    }
    return leer(document.body);
  });

  await close();

  return {
    project,
    emails,
    count,
    limitLine,
    // Si la consola no muestra el conteo no se puede afirmar nada sobre los usuarios.
    countReliable: count !== null,
  };
}

/** Compatibilidad: la lista de correos suelta, como array. */
export async function listTestUsers(opts = {}) {
  const { emails } = await readAudience(opts);
  return emails;
}

/**
 * Lee la pagina de marca: cada campo con su etiqueta y si esta vacio.
 *
 * Campos obligatorios para publicar: pagina principal, politica de privacidad,
 * condiciones del servicio y correo de contacto del desarrollador.
 */
export async function getBranding({ project, port, profile, settleMs } = {}) {
  const { page, close } = await openPage(authUrl(SCREENS.branding, project), { port, profile, settleMs });

  const all = await fields(page);
  const btns = await buttons(page);
  const save = btns.find((b) => T.saveButton.test(b.text));

  // La lista de "Dominios autorizados" se lee del texto, no de los inputs.
  const domains = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("input")) {
      const v = (el.value || "").trim();
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) && !v.includes("@")) out.push(v);
    }
    return [...new Set(out)];
  });

  const result = { project, fields: all, authorizedDomains: domains, saveEnabled: save ? !save.disabled : null };

  await close();
  return result;
}

// ─── Clientes OAuth ───────────────────────────────────────────────────────────

const CLIENT_ID_RE = /auth\/clients\/(\d{6,}-[a-z0-9.]+\.apps\.googleusercontent\.com)/i;

/**
 * Lista los clientes OAuth del proyecto.
 *
 * El diagnostico viejo no miraba esto, y es lo primero que hay que saber: sin cliente no
 * existe Client ID y el login es imposible por mas que la pantalla de consentimiento este
 * perfecta.
 */
export async function listClients({ project, port, profile, settleMs } = {}) {
  const { page, close } = await openPage(authUrl(SCREENS.clients, project), { port, profile, settleMs });

  const clients = await page.evaluate((fuente) => {
    const re = new RegExp(fuente, "i");
    const out = [];

    for (const a of document.querySelectorAll("a[href]")) {
      const m = (a.getAttribute("href") || "").match(re);
      if (!m) continue;
      const clientId = m[1];
      if (out.some((c) => c.clientId === clientId)) continue;
      const nombre = (a.innerText || "").trim().split("\n")[0]?.trim() ?? "";
      out.push({ clientId, nombre });
    }
    return out;
  }, CLIENT_ID_RE.source);

  await close();
  return clients;
}

/**
 * Lee el detalle de un cliente: nombre y URIs de redireccionamiento autorizados.
 *
 * OJO CON EL DIALOGO DE EDICION: al abrir el detalle se monta encima un dialogo con
 * Guardar/Cancelar, y los redirect URIs viven en SUS inputs. Para leer los redirects hay que
 * dejarlo abierto (cerrarlo los esconde). Para leer el SECRETO es al reves: hay que cerrarlo,
 * porque mientras esta abierto la seccion de secretos no esta en el DOM.
 */
export async function readClient({ project, clientId, port, profile, settleMs } = {}) {
  const url = `https://console.cloud.google.com/auth/clients/${encodeURIComponent(clientId)}?project=${encodeURIComponent(project)}`;
  const { page, close } = await openPage(url, { port, profile, settleMs });

  // El detalle es un modal con scroll propio: hay que scrollearlo para que renderice todo.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const urls = [];

    for (const el of document.querySelectorAll("input, textarea")) {
      const v = (el.value || "").trim();
      if (/^https?:\/\//i.test(v)) urls.push(v);
    }
    for (const m of (document.body.innerText || "").match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
      urls.push(m);
    }

    const lineas = (document.body.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      // Se descartan las URLs de la propia consola (avatares, ayuda, el enlace del proyecto).
      redirectUris: [...new Set(urls)].filter(
        (u) => !/console\.cloud\.google\.com|accounts\.google\.com|support\.google\.com/i.test(u),
      ),
      textoInicial: lineas.slice(0, 6).join(" / ").slice(0, 160),
    };
  });

  await close();
  return { project, clientId, ...data };
}

/**
 * Estado completo del proyecto, con lo que falta para que el login funcione y lo que falta
 * para poder publicar.
 *
 * DOS NIVELES, PORQUE NO ES LO MISMO
 *  - `level: "login"`   → sin esto NO ENTRA NADIE. Es lo urgente.
 *  - `level: "publish"` → el login funciona igual para los usuarios de prueba, pero la app
 *                         esta limitada a 100 usuarios de por vida.
 *
 * LO QUE EL DIAGNOSTICO VIEJO NO MIRABA
 * No comprobaba que existiera un cliente OAuth. Un proyecto podia salir "sin bloqueos, el
 * login deberia funcionar" sin tener Client ID con el que iniciar sesion. Tampoco contaba
 * bien los usuarios de prueba (ver `readAudience`). Los dos huecos daban falso "esta listo".
 *
 * `redirect` es opcional: si lo pasas, se verifica que algun cliente lo tenga autorizado.
 */
export async function diagnose({ project, port, profile, settleMs, redirect } = {}) {
  const pub = await getPublishStatus({ project, port, profile, settleMs });
  const brand = await getBranding({ project, port, profile, settleMs });
  const audience = await readAudience({ project, port, profile, settleMs });
  const clients = await listClients({ project, port, profile, settleMs });

  const blockers = [];

  // ── Nivel login ──────────────────────────────────────────────────────────────

  if (!clients.length) {
    blockers.push({
      level: "login",
      code: "NO_OAUTH_CLIENT",
      detail:
        "El proyecto no tiene ningun cliente OAuth, asi que no hay Client ID ni secret con " +
        "los que iniciar sesion.",
      fix: `gauth create --project ${project} --name "<app>" --redirect <url> --email <correo>`,
    });
  } else if (redirect) {
    const esperado = redirect.replace(/\/+$/, "");
    let encontrado = false;
    const vistos = [];

    for (const c of clients) {
      const detalle = await readClient({ project, clientId: c.clientId, port, profile, settleMs });
      vistos.push(...detalle.redirectUris);
      if (detalle.redirectUris.some((u) => u.replace(/\/+$/, "") === esperado)) {
        encontrado = true;
        break;
      }
    }

    if (!encontrado) {
      blockers.push({
        level: "login",
        code: "REDIRECT_MISSING",
        detail:
          `Ningun cliente tiene autorizado el redirect ${redirect}. ` +
          `Los que hay: ${[...new Set(vistos)].join(", ") || "(ninguno)"}. ` +
          "Google rechaza el login con redirect_uri_mismatch antes de tocar tu app.",
        fix: "Agregá esa URI al cliente en la consola, o volvé a crearlo: gauth create ... --redirect <url>",
      });
    }
  }

  if (audience.countReliable && audience.count === 0) {
    blockers.push({
      level: "login",
      code: "NO_TEST_USERS",
      detail:
        "La app esta en Prueba y no tiene usuarios de prueba: Google rechaza el login ANTES de " +
        "llegar a tu app, asi que no vas a ver nada en tus logs.",
      fix: `gauth test-users add --project ${project} --emails a@x.com,b@y.com`,
    });
  }

  // ── Nivel publicar ───────────────────────────────────────────────────────────

  const missing = brand.fields.filter((f) => f.empty);
  const urls = missing.filter((f) =>
    /principal|homepage|privacidad|privacy|condiciones|terms/i.test(f.label),
  );
  const contact = missing.filter((f) => /correo|email/i.test(f.label));

  if (pub.publishingStatus === "testing") {
    blockers.push({
      level: "publish",
      code: "NOT_PUBLISHED",
      detail:
        "La app esta en estado Prueba: solo entran los usuarios de prueba (limite 100 en total, " +
        "se cuenta todo el ciclo de vida de la app).",
      fix: `gauth publish --project ${project}`,
    });
  }

  if (urls.length) {
    blockers.push({
      level: "publish",
      code: "BRANDING_URLS_MISSING",
      detail: `Faltan enlaces obligatorios para publicar: ${urls.map((f) => f.label).join(", ")}`,
      fix: `gauth branding --project ${project} --homepage <url> --privacy <url> --terms <url>`,
    });
  }

  if (contact.length) {
    blockers.push({
      level: "publish",
      code: "BRANDING_CONTACT_MISSING",
      detail: "Falta el correo de contacto del desarrollador.",
      fix: `gauth branding --project ${project} --contact <email>`,
    });
  }

  const loginBlockers = blockers.filter((b) => b.level === "login");

  return {
    project,
    publish: pub,
    branding: brand,
    audience,
    clients,
    testUsers: audience.emails,
    testUsersCount: audience.countReliable ? audience.count : audience.emails.length,
    blockers,
    // `loginReady` es la pregunta que importa: ¿puede entrar alguien hoy?
    // Si no se paso `redirect` no se pudo comprobar el redirect, y decirlo es parte de no
    // mentir: sin ese dato el "listo" es solo sobre lo que si se miro.
    redirectVerified: Boolean(redirect),
    loginReady: clients.length > 0 && loginBlockers.length === 0,
    ok: blockers.length === 0,
  };
}

// ─── Marca ────────────────────────────────────────────────────────────────────

/**
 * Completa la pagina de marca. Solo escribe los campos que le pasas.
 *
 * AVISO: subir un logotipo obliga a enviar la app a verificacion, salvo que este en
 * modo Prueba o sea interna. Este comando NO sube logotipo a proposito.
 */
export async function fillBranding(
  { project, homepage, privacy, terms, contact, port, profile, settleMs = 8000 } = {},
) {
  const { page, close } = await openPage(authUrl(SCREENS.branding, project), { port, profile, settleMs });

  // Cada campo dice con que funcion se escribe. El correo de contacto es un chip list
  // de Material: `setField` ahi no persiste nada aunque el guardado parezca andar.
  const targets = [
    [/p[aá]gina principal|home ?page|application home/i, homepage, "homepage", setField],
    [/pol[ií]tica de privacidad|privacy policy/i, privacy, "privacy", setField],
    [/condiciones del servicio|terms of service/i, terms, "terms", setField],
    [/direcciones de correo|developer contact|email addresses/i, contact, "contact", typeIntoField],
  ];

  const written = [];
  for (const [pattern, value, name, write] of targets) {
    if (!value) continue;
    const r = await write(page, pattern, value);
    written.push({ field: name, ok: r.ok, label: r.label ?? null });
  }

  if (!written.some((w) => w.ok)) {
    await close();
    return { ok: false, written, error: "No se pudo identificar ningun campo para escribir." };
  }

  // "Guardar" se habilita solo si Angular registro el cambio.
  await page.waitForTimeout(1500);
  const save = await clickByText(page, T.saveButton);

  if (!save.ok) {
    await close();
    return { ok: false, written, error: `Boton Guardar no disponible: ${JSON.stringify(save)}` };
  }

  // Esperar a que cierre el aviso antes de verificar: recargar antes da falso negativo.
  await page.waitForTimeout(4000);
  await reload(page, 8000);

  const after = await fields(page);
  const pageText = await bodyText(page);
  const persisted = targets
    .filter(([, value]) => value)
    .map(([, value, name]) => ({
      field: name,
      value,
      // Un chip list no deja el valor en el input, asi que tambien se busca en el
      // texto de la pagina. Mirar solo `el.value` daba falsos negativos.
      persisted: pageText.includes(value) || after.some((f) => f.value === value),
    }));

  await close();

  const allPersisted = persisted.every((p) => p.persisted);
  return {
    ok: allPersisted,
    written,
    persisted,
    error: allPersisted
      ? null
      : "Google no persistio algun valor. Causa habitual: falta la Politica de Privacidad o " +
        "los Terminos, que son obligatorios para publicar. Corre 'gauth diagnose'.",
  };
}

// ─── Usuarios de prueba ───────────────────────────────────────────────────────

/**
 * Agrega usuarios de prueba. Es lo mas importante despues de crear un cliente: una app en
 * Prueba sin usuarios rechaza a TODOS, y el sintoma es "el login no anda" sin nada en los logs.
 *
 * LO QUE ESTABA MAL (y por que esto no es un `fill` mas)
 * El campo de correos es un **chip list de Material**, no un `<input>` normal. Por eso:
 *   - no tiene `type`, asi que buscar `input[type=text]` o `textarea` no lo encuentra;
 *   - no acepta varios correos separados por comas: cada uno se confirma con Enter y se
 *     convierte en un chip;
 *   - despues de cada Enter el input queda VACIO a proposito: eso significa que el chip se
 *     creo, no que fallo.
 * Y dos trampas mas de Playwright/consola:
 *   - `locator.filter({ visible: true })` NO existe: la visibilidad va en el selector
 *     (`input:visible`).
 *   - El guardado no se registra con `getByRole(...).click()`; hay que disparar el clic por JS.
 *
 * La verificacion no es "el texto aparece en la pagina del dialogo": se vuelve a leer el
 * conteo de la consola y se exige que haya CRECIDO. Recargar enseguida da falso negativo.
 */
export async function addTestUsers({ project, emails, port, profile, settleMs = 8000 } = {}) {
  const list = (Array.isArray(emails) ? emails : String(emails ?? "").split(/[,\s;]+/))
    .map((e) => e.trim())
    .filter(Boolean);

  if (!list.length) throw new Error("Pasá al menos un correo en --emails");

  const before = await readAudience({ project, port, profile, settleMs });
  const pendientes = list.filter((e) => !before.emails.includes(e));
  if (!pendientes.length) {
    return {
      ok: true,
      requested: list,
      added: list,
      missing: [],
      note: "Ya estaban como usuarios de prueba.",
      countBefore: before.count,
      countAfter: before.count,
    };
  }

  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });

  const opened = await clickByText(page, T.addUsersButton);
  if (!opened.ok) {
    await close();
    return { ok: false, error: `No encontre el boton de agregar usuarios: ${JSON.stringify(opened)}` };
  }
  await page.waitForTimeout(2500);

  const input = page.locator("input:visible").last();
  await input.click().catch(() => {});

  for (const email of pendientes) {
    await input.fill(email);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
  }

  await page.evaluate(() => {
    const scope = document.querySelector(".cdk-overlay-pane, [role=dialog]") ?? document;
    const b = [...scope.querySelectorAll("button")].find((x) =>
      /guardar|save/i.test((x.innerText || "").trim()),
    );
    if (b) b.click();
  });

  // Esperar a que el dialogo desaparezca. No se busca el texto del boton "Agregar usuarios"
  // porque ese texto sigue en la pagina de fondo y el bucle nunca terminaria (asi tardaba
  // 30s cada corrida).
  for (let i = 0; i < 20; i += 1) {
    const abierto = await page.evaluate(
      () => !!document.querySelector(".cdk-overlay-pane [role=dialog], mat-dialog-container"),
    );
    if (!abierto) break;
    await page.waitForTimeout(1000);
  }

  await close();

  const after = await readAudience({ project, port, profile, settleMs });
  const crecimiento =
    before.count !== null && after.count !== null ? after.count - before.count : null;
  const presentes = pendientes.filter((e) => after.emails.includes(e));

  return {
    ok: crecimiento === null ? presentes.length === pendientes.length : crecimiento >= pendientes.length,
    requested: list,
    added: presentes,
    missing: pendientes.filter((e) => !presentes.includes(e)),
    countBefore: before.count,
    countAfter: after.count,
  };
}

/** Quita usuarios de prueba. */
export async function removeTestUsers({ project, emails, port, profile, settleMs = 8000 } = {}) {
  const list = (Array.isArray(emails) ? emails : String(emails ?? "").split(/[,\s;]+/))
    .map((e) => e.trim())
    .filter(Boolean);

  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });

  const removed = [];
  for (const email of list) {
    const r = await page.evaluate((target) => {
      const rows = [...document.querySelectorAll("tr, [role=row], li")];
      const row = rows.find((n) => (n.innerText || "").includes(target));
      if (!row) return { ok: false };
      const btn = row.querySelector("button[aria-label*='orrar'], button[aria-label*='elete'], button");
      if (!btn) return { ok: false, found: "row" };
      btn.click();
      return { ok: true };
    }, email);

    if (r.ok) {
      await page.waitForTimeout(1500);
      const confirm = await clickByText(page, /^(Borrar|Eliminar|Quitar|Delete|Remove)$/i);
      if (!confirm.ok) await clickByText(page, /^(Borrar|Eliminar|Quitar|Delete|Remove)$/i, "body");
      await page.waitForTimeout(2500);
      removed.push(email);
    }
  }

  await reload(page, 8000);
  const text = await bodyText(page);
  await close();

  return { requested: list, removed, stillPresent: list.filter((e) => text.includes(e)) };
}

// ─── Publicar ─────────────────────────────────────────────────────────────────

/**
 * Publica la app para que deje de estar limitada a los usuarios de prueba.
 *
 * Si "Publicar app" esta deshabilitado, NO forcejea: devuelve el diagnostico con lo
 * que falta. Insistir con clics no cambia nada porque el bloqueo es del servidor.
 */
export async function publishApp({ project, port, profile, settleMs = 8000 } = {}) {
  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });

  const before = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((n) =>
      /^(Publicar app|Publish app)$/i.test((n.innerText || "").trim()),
    );
    return b ? { found: true, disabled: b.disabled } : { found: false };
  });

  if (!before.found) {
    await close();
    return { ok: false, error: "No encontre el boton 'Publicar app'. Revisa que tengas permiso de Owner." };
  }

  if (before.disabled) {
    const text = await lines(page);
    const idx = text.findIndex((l) => /debes completar|must complete|complete the/i.test(l));
    await close();
    return {
      ok: false,
      blocked: true,
      error: "El boton 'Publicar app' esta deshabilitado: falta completar la marca.",
      message: idx >= 0 ? text[idx] : null,
      hint: "Corre 'gauth diagnose' para ver exactamente que falta.",
    };
  }

  const clicked = await clickByText(page, T.publishButton);
  if (!clicked.ok) {
    await close();
    return { ok: false, error: `No pude clickear: ${JSON.stringify(clicked)}` };
  }

  // Google muestra un dialogo de confirmacion.
  await page.waitForTimeout(3000);
  const confirmed = await clickByText(page, /^(Confirmar|Confirm|Publicar|Publish)$/i);
  await page.waitForTimeout(4000);
  await reload(page, 9000);

  const after = await lines(page);
  const stillTesting = after.some((l) => matchAny(l, T.test));
  await close();

  return {
    ok: !stillTesting,
    confirmed: confirmed.ok,
    status: stillTesting ? "testing" : "production",
    note: stillTesting
      ? "Sigue en Prueba. Puede requerir verificar el dominio, o el cambio tarda unos minutos."
      : "App publicada: ya no esta limitada a los usuarios de prueba.",
  };
}
