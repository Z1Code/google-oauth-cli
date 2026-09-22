/**
 * `gauth ensure` — lleva un proyecto de "recien creado" a "el login funciona" en una corrida.
 *
 * EL PROBLEMA QUE RESUELVE
 * Antes esto eran cinco comandos separados que habia que correr en el orden correcto
 * (`create`, `test-users add`, `branding`, `publish`, `diagnose`), cada uno con sus trampas.
 * Si te saltabas uno, nada te avisaba: el proyecto quedaba a medias y el sintoma era
 * "el login no anda". Y como `diagnose` tampoco miraba que existiera el cliente, podia
 * responder "sin bloqueos" sobre un proyecto donde no entraba nadie. De ahi la sensacion de
 * estar siempre corrigiendo lo mismo, sin importar cuantos sitios se hubieran integrado.
 *
 * COMO FUNCIONA
 * Es un bucle que converge contra el estado REAL, no una secuencia de clics a ciegas:
 *
 *   1. Lee el estado (diagnose, que ahora si verifica cliente, redirect y usuarios).
 *   2. Si no hay bloqueos que impidan entrar, TERMINA y devuelve las credenciales.
 *   3. Si hay, arregla UN paso (el primero accionable de la lista).
 *   4. Vuelve al paso 1.
 *
 * Y dos garantias que antes no existian:
 *   - **No da vueltas infinitas:** si una vuelta deja los mismos bloqueos que la anterior,
 *     corta. Insistir no cambia nada porque el bloqueo es del servidor.
 *   - **No termina "a medias":** siempre devuelve un veredicto. O `listo`, o `trabado` con el
 *     motivo exacto y lo que hace falta de un humano.
 *
 * Solo se auto-arregla lo que impide el login. Lo que falta para PUBLICAR (las URLs de
 * privacidad y terminos) no se inventa: se informa aparte, porque el login con usuarios de
 * prueba funciona igual sin publicar.
 */

import { addTestUsers, diagnose } from "./consent.mjs";

/** Cuantas vueltas de "leer, arreglar, releer" antes de rendirse. */
const MAX_VUELTAS = 4;

const esDeLogin = (b) => b.level === "login";

/**
 * @param {object} opts
 * @param {string} [opts.name]     Nombre de la app, para crear el cliente.
 * @param {string} [opts.redirect] Redirect URI que tiene que quedar autorizado.
 * @param {string} [opts.email]    Correo de soporte, para crear el cliente.
 * @param {string} [opts.emails]   Correos a cargar como usuarios de prueba.
 * @param {(o: object) => Promise<object>} opts.crearCliente
 *   Se inyecta desde el CLI: la creacion vive en `lib/oauth-client.mjs`, que se ejecuta como
 *   proceso aparte a proposito (tiene efectos al importarse). Devuelve `{clientId, clientSecret}`.
 */
export async function ensureProject({
  project,
  name,
  redirect,
  email,
  emails,
  port,
  profile,
  settleMs,
  crearCliente,
} = {}) {
  const pasos = [];
  let credenciales = null;
  let firmaAnterior = null;

  for (let vuelta = 1; vuelta <= MAX_VUELTAS; vuelta += 1) {
    const estado = await diagnose({ project, port, profile, settleMs, redirect });

    const bloqueosLogin = estado.blockers.filter(esDeLogin);
    const pendientesPublicar = estado.blockers.filter((b) => !esDeLogin(b));

    // ── Se termino: nadie mas que arreglar para que se pueda entrar ──────────────
    if (!bloqueosLogin.length) {
      return {
        ok: true,
        veredicto: "listo",
        project,
        credenciales,
        vueltas: vuelta,
        pasos,
        cliente: estado.clients[0] ?? null,
        usuariosDePrueba: estado.testUsersCount,
        publicado: estado.publish.publishingStatus === "production",
        pendienteParaPublicar: pendientesPublicar,
        motivo: estado.publish.publishingStatus === "production"
          ? "El login funciona y la app esta publicada."
          : "El login funciona. La app sigue en Prueba: solo entran los usuarios de prueba " +
            "(limite de 100 en todo el ciclo de vida).",
      };
    }

    // ── Deteccion de progreso: si nada cambio, insistir no sirve ─────────────────
    const firma = bloqueosLogin.map((b) => b.code).sort().join(",");
    if (firma === firmaAnterior) {
      return {
        ok: false,
        veredicto: "trabado",
        project,
        credenciales,
        vueltas: vuelta,
        pasos,
        bloqueos: bloqueosLogin,
        pendienteParaPublicar: pendientesPublicar,
        motivo:
          "La vuelta anterior dejo exactamente los mismos bloqueos, asi que reintentar no " +
          "cambia nada. Suele ser un bloqueo del lado de Google o un dato que falta.",
      };
    }
    firmaAnterior = firma;

    // ── Elegir el paso a dar ─────────────────────────────────────────────────────
    const accion = elegirAccion(bloqueosLogin, {
      project,
      name,
      redirect,
      email,
      emails,
      crearCliente,
    });

    if (accion.faltanDatos) {
      return {
        ok: false,
        veredicto: "trabado",
        project,
        credenciales,
        vueltas: vuelta,
        pasos,
        bloqueos: bloqueosLogin,
        pendienteParaPublicar: pendientesPublicar,
        faltanDatos: accion.faltanDatos,
        motivo:
          `Para ${accion.code} hace falta pasar ${accion.faltanDatos.join(", ")}. ` +
          "Son datos que no se pueden adivinar.",
      };
    }

    if (accion.manual) {
      return {
        ok: false,
        veredicto: "trabado",
        project,
        credenciales,
        vueltas: vuelta,
        pasos,
        bloqueos: bloqueosLogin,
        pendienteParaPublicar: pendientesPublicar,
        motivo: accion.manual,
      };
    }

    // ── Ejecutar y registrar ─────────────────────────────────────────────────────
    let resultado;
    try {
      resultado = await accion.ejecutar();
    } catch (err) {
      resultado = { ok: false, error: err.message };
    }

    pasos.push({ vuelta, accion: accion.code, resultado });

    if (accion.code === "NO_OAUTH_CLIENT" || accion.code === "REDIRECT_MISSING") {
      if (resultado?.clientId && resultado?.clientSecret) {
        credenciales = { clientId: resultado.clientId, clientSecret: resultado.clientSecret };
      }
    }
  }

  return {
    ok: false,
    veredicto: "trabado",
    project,
    credenciales,
    vueltas: MAX_VUELTAS,
    pasos,
    motivo: `Se agotaron las ${MAX_VUELTAS} vueltas sin llegar a un estado estable.`,
  };
}

/** Decide que hacer con el primer bloqueo que se pueda resolver solo. */
function elegirAccion(bloqueos, { project, name, redirect, email, emails, crearCliente }) {
  for (const b of bloqueos) {
    if (b.code === "NO_OAUTH_CLIENT") {
      const faltan = [];
      if (!name) faltan.push("--name");
      if (!redirect) faltan.push("--redirect");
      if (!email) faltan.push("--email");
      if (faltan.length) return { code: b.code, faltanDatos: faltan };

      return {
        code: b.code,
        ejecutar: () => crearCliente({ project, name, redirect, email }),
      };
    }

    if (b.code === "NO_TEST_USERS") {
      if (!emails) return { code: b.code, faltanDatos: ["--emails"] };
      return {
        code: b.code,
        ejecutar: () => addTestUsers({ project, emails }),
      };
    }

    if (b.code === "REDIRECT_MISSING") {
      // La resolucion sana es crear un cliente NUEVO con el redirect correcto. El que existe
      // apunta a otro entorno (tipicamente el de desarrollo, con localhost), y conviene
      // tenerlos separados: si se le metiera el redirect de produccion al de desarrollo, los
      // dos entornos compartirian credenciales. Es lo que hace un humano a mano.
      const faltan = [];
      if (!name) faltan.push("--name");
      if (!email) faltan.push("--email");
      if (faltan.length) {
        return {
          code: b.code,
          faltanDatos: faltan,
        };
      }

      return {
        code: b.code,
        ejecutar: () => crearCliente({ project, name, redirect, email }),
      };
    }
  }

  return {
    code: bloqueos[0]?.code ?? "desconocido",
    manual: `No se como resolver automaticamente el bloqueo ${bloqueos[0]?.code}.`,
  };
}
