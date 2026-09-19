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
  // La linea util es la que trae el numero: "3 usuarios (3 de prueba, ...)/limite de 100".
  // Buscar solo por la palabra "limite" engancha el titulo de la seccion y devuelve basura.
  const limitLine = text.find((l) => /\d+\s*(usuarios|users)\s*\(/i.test(l)) ?? null;

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
 * Lee los usuarios de prueba cargados.
 * Ojo: la lista viene en una tabla; devuelve lo que se pueda leer como texto.
 */
export async function listTestUsers({ project, port, profile, settleMs } = {}) {
  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });

  const emails = await page.evaluate(() => {
    const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    return [...new Set((document.body.innerText || "").match(re) ?? [])];
  });

  await close();
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

/**
 * Estado completo, con la lista de lo que impide publicar.
 * Es el comando que conviene correr primero cuando "el login no anda".
 */
export async function diagnose({ project, port, profile, settleMs } = {}) {
  const pub = await getPublishStatus({ project, port, profile, settleMs });
  const brand = await getBranding({ project, port, profile, settleMs });
  const users = await listTestUsers({ project, port, profile, settleMs });

  const blockers = [];

  const missing = brand.fields.filter((f) => f.empty);
  const urls = missing.filter((f) => /principal|homepage|privacidad|privacy|condiciones|terms/i.test(f.label));
  const contact = missing.filter((f) => /correo|email/i.test(f.label));

  if (pub.publishingStatus === "testing") {
    blockers.push({
      code: "NOT_PUBLISHED",
      detail:
        "La app esta en estado Prueba: solo entran los usuarios de prueba (limite 100 en total, " +
        "se cuenta todo el ciclo de vida de la app).",
      fix: "gauth publish --project <id>",
    });
  }

  if (urls.length) {
    blockers.push({
      code: "BRANDING_URLS_MISSING",
      detail: `Faltan enlaces obligatorios para publicar: ${urls.map((f) => f.label).join(", ")}`,
      fix: "Creá esas páginas en tu sitio y luego: gauth branding --homepage <url> --privacy <url> --terms <url>",
    });
  }

  if (contact.length) {
    blockers.push({
      code: "BRANDING_CONTACT_MISSING",
      detail: "Falta el correo de contacto del desarrollador.",
      fix: "gauth branding --contact <email>",
    });
  }

  if (pub.publishingStatus === "testing" && users.length === 0) {
    blockers.push({
      code: "NO_TEST_USERS",
      detail:
        "La app esta en Prueba y no tiene usuarios de prueba: Google rechaza el login ANTES de " +
        "llegar a tu app, asi que no vas a ver nada en tus logs.",
      fix: "gauth test-users add --project <id> --emails a@x.com,b@y.com",
    });
  }

  return {
    project,
    publish: pub,
    branding: brand,
    testUsers: users,
    testUsersCount: users.length,
    blockers,
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
 * Agrega usuarios de prueba.
 *
 * Es lo mas importante despues de crear un cliente: una app en Prueba sin usuarios
 * de prueba rechaza a todos, y el sintoma es "el login no anda" sin errores.
 */
export async function addTestUsers({ project, emails, port, profile, settleMs = 8000 } = {}) {
  const list = (Array.isArray(emails) ? emails : String(emails ?? "").split(/[,\s;]+/))
    .map((e) => e.trim())
    .filter(Boolean);

  if (!list.length) throw new Error("Pasá al menos un correo en --emails");

  const { page, close } = await openPage(authUrl(SCREENS.audience, project), { port, profile, settleMs });

  const opened = await clickByText(page, T.addUsersButton);
  if (!opened.ok) {
    await close();
    return { ok: false, error: `No encontre el boton de agregar usuarios: ${JSON.stringify(opened)}` };
  }

  // El dialogo expone un textarea (o un input) para la lista de correos.
  await waitForText(page, list[0], 5000).catch(() => {});
  await page.waitForTimeout(2500);

  const filled = await page.evaluate((value) => {
    const root =
      document.querySelector(".cdk-overlay-pane, [role=dialog], mat-dialog-container") || document;
    const el = root.querySelector("textarea, input[type=text], input[type=email]");
    if (!el) return { ok: false };
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, tag: el.tagName.toLowerCase() };
  }, list.join(", "));

  if (!filled.ok) {
    await close();
    return { ok: false, error: "El dialogo no tiene un campo donde escribir los correos." };
  }

  await page.waitForTimeout(1200);
  const saved = await clickByText(page, T.saveButton);

  if (!saved.ok) {
    await close();
    return { ok: false, error: `No pude guardar el dialogo: ${JSON.stringify(saved)}` };
  }

  await page.waitForTimeout(4000);
  await reload(page, 8000);

  const present = await page.evaluate(() => document.body.innerText || "");
  const added = list.filter((e) => present.includes(e));

  await close();
  return { ok: added.length === list.length, requested: list, added, missing: list.filter((e) => !added.includes(e)) };
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
