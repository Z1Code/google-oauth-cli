/**
 * Interacciones con la Google Cloud Console.
 *
 * La consola es Angular Material y rompe las abstracciones normales de Playwright.
 * Estas funciones encapsulan lo que si funciona.
 *
 * TRAMPAS QUE CUESTAN TIEMPO (no borrar):
 *
 * 1. `locator.filter({ visible: true })` NO EXISTE en Playwright.
 *    Solo hay has / hasNot / hasText / hasNotText. Para visibilidad, el
 *    pseudo-selector CSS `input:visible`.
 *
 * 2. `getByRole(...).click()` PUEDE NO REGISTRAR EL GUARDADO.
 *    El boton existe, es visible y esta en el overlay, y el formulario no se guarda.
 *    `clickByText()` hace el clic por JS y si funciona.
 *
 * 3. `page.screenshot()` SE CUELGA en varias pantallas de la consola (espera fuentes).
 *    Verifica con `bodyText()`, no con capturas.
 *
 * 4. RECARGAR INMEDIATAMENTE DESPUES DE GUARDAR DA FALSO NEGATIVO.
 *    Hay que esperar a que el dialogo desaparezca (`waitForTextGone`) antes de verificar.
 *
 * 5. Los inputs NO TIENEN aria-label.
 *    Hay que identificar cada campo por el texto del bloque que lo contiene.
 */

/** Todo el texto visible de la pagina. La forma confiable de verificar estado. */
export function bodyText(page) {
  return page.evaluate(() => document.body.innerText || "");
}

/** Lineas no vacias de la pagina, recortadas. */
export async function lines(page) {
  return (await bodyText(page))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Click por JS sobre el primer boton/enlace cuyo texto matchee.
 * `scope` limita la busqueda (por defecto usa el overlay de un dialogo, si hay uno).
 */
export async function clickByText(page, pattern, scope) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");

  return page.evaluate(
    ({ source, flags, scopeSel }) => {
      const root =
        (scopeSel && document.querySelector(scopeSel)) ||
        document.querySelector(".cdk-overlay-pane, [role=dialog], mat-dialog-container") ||
        document;

      const rx = new RegExp(source, flags);
      const nodes = [...root.querySelectorAll("button, a, [role=button]")];
      const hit = nodes.find((n) => rx.test((n.innerText || "").trim()));

      if (!hit) {
        return {
          ok: false,
          candidates: nodes.map((n) => (n.innerText || "").trim()).filter(Boolean).slice(0, 15),
        };
      }

      if (hit.disabled || hit.getAttribute("aria-disabled") === "true") {
        return { ok: false, disabled: true, clicked: (hit.innerText || "").trim() };
      }

      hit.click();
      return { ok: true, clicked: (hit.innerText || "").trim().slice(0, 60) };
    },
    { source: re.source, flags: re.flags, scopeSel: scope },
  );
}

/** Todos los botones de la pagina con su estado. Util para diagnosticar. */
export async function buttons(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, [role=button]")]
      .map((b) => ({
        text: (b.innerText || "").trim().slice(0, 50),
        disabled: b.disabled || b.getAttribute("aria-disabled") === "true",
      }))
      .filter((b) => b.text),
  );
}

/** Espera a que un texto desaparezca (por ejemplo, que un dialogo se cierre). */
export async function waitForTextGone(page, text, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await bodyText(page)).includes(text)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Espera a que un texto aparezca. */
export async function waitForText(page, text, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await bodyText(page)).includes(text)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Recarga y espera: para leer el estado ya persistido en el servidor. */
export async function reload(page, settleMs = 7000) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(settleMs);
}

/**
 * Campos de texto de la pagina, cada uno con la etiqueta que lo describe.
 *
 * `aria-label` no sirve: la consola no lo pone. Se sube por el DOM hasta encontrar el
 * bloque mas cercano que contenga texto, y se usa su primera linea como etiqueta.
 *
 * OJO CON LOS CHIP LISTS: en un `mat-chip-grid` el valor NO vive en `el.value`, que
 * queda siempre vacio por diseno. Leer solo el input hace que el campo parezca vacio
 * aunque tenga valores cargados, y eso produce bloqueos falsos (el correo de contacto
 * del desarrollador y los usuarios de prueba son de este tipo). Por eso se leen los
 * chips del contenedor.
 */
export function fields(page) {
  return page.evaluate(() => {
    const SKIP = ["search", "hidden", "file", "checkbox", "radio", "submit", "button"];
    const CHIP = "mat-chip, .mat-mdc-chip, mat-chip-row, .mat-mdc-chip-row";
    const out = [];

    for (const el of document.querySelectorAll("input, textarea")) {
      const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
      if (SKIP.includes(type)) continue;

      let label = "";
      let node = el;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const text = (node.innerText || "").trim();
        if (text.length > 0 && text.length < 600) {
          label = text.split("\n")[0].trim();
          break;
        }
      }

      const grid = el.closest(
        "mat-chip-grid, mat-chip-list, .mat-mdc-chip-set, .mat-mdc-chip-grid, [class*=chip-grid]",
      );
      const chips = grid
        ? [...grid.querySelectorAll(CHIP)].map((c) => (c.innerText || "").trim()).filter(Boolean)
        : [];

      const value = chips.length ? chips.join(", ") : (el.value || "").trim();

      out.push({
        type,
        label: label.slice(0, 90),
        value,
        chips,
        empty: !value,
      });
    }
    return out;
  });
}

/**
 * Escribe en un campo tipo "chip list" de Angular Material.
 *
 * Estos campos NO leen `el.value`: el valor entra como un chip recién al presionar
 * Enter, así que hace falta teclado real y no un set por JavaScript. `setField` acá no
 * alcanza y el guardado parece funcionar pero no persiste nada.
 *
 * Después de cada Enter el input queda VACÍO a propósito: eso significa que el chip se
 * creó, no que falló. No lo interpretes como error.
 *
 * Pasa en dos lugares de la consola: los usuarios de prueba y las direcciones de
 * contacto del desarrollador.
 */
export async function typeIntoField(page, pattern, value) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");

  const found = await page.evaluate(
    ({ source, flags }) => {
      const rx = new RegExp(source, flags);
      const SKIP = ["search", "hidden", "file", "checkbox", "radio", "submit", "button"];

      for (const el of document.querySelectorAll("input, textarea")) {
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        if (SKIP.includes(type)) continue;

        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          const text = (node.innerText || "").trim();
          if (text.length > 0 && text.length < 600 && rx.test(text)) {
            // Marca temporal para que Playwright pueda enfocar exactamente este input.
            el.setAttribute("data-oauth-target", "1");
            return { ok: true, label: text.split("\n")[0].slice(0, 70) };
          }
        }
      }
      return { ok: false };
    },
    { source: re.source, flags: re.flags },
  );

  if (!found.ok) return found;

  const input = page.locator('[data-oauth-target="1"]').first();
  await input.click();
  await page.keyboard.type(value, { delay: 40 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);

  const chipCreated = await page.evaluate((v) => (document.body.innerText || "").includes(v), value);

  await page.evaluate(() =>
    document.querySelectorAll("[data-oauth-target]").forEach((n) => n.removeAttribute("data-oauth-target")),
  );

  return { ...found, chipCreated };
}

/**
 * Escribe en el campo cuyo bloque de texto matchee `pattern`.
 *
 * El valor se setea por JS y se dispara `input`: el value accessor de Angular lee el
 * DOM en ese evento y actualiza el FormControl. Un `fill()` de Playwright a veces deja
 * el control de Angular sin enterarse y el guardado no persiste.
 *
 * Sirve para inputs normales. Para chip lists va `typeIntoField`.
 */
export function setField(page, pattern, value) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");

  return page.evaluate(
    ({ source, flags, value }) => {
      const rx = new RegExp(source, flags);
      const SKIP = ["search", "hidden", "file", "checkbox", "radio", "submit", "button"];

      for (const el of document.querySelectorAll("input, textarea")) {
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        if (SKIP.includes(type)) continue;

        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          const text = (node.innerText || "").trim();
          if (text.length > 0 && text.length < 600 && rx.test(text)) {
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
            return { ok: true, label: text.split("\n")[0].slice(0, 70) };
          }
        }
      }
      return { ok: false };
    },
    { source: re.source, flags: re.flags, value },
  );
}
