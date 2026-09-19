#!/usr/bin/env node
/**
 * Smoke test del servidor MCP: habla el protocolo de verdad por stdio.
 *
 * No toca Google ni necesita credenciales: solo verifica que el servidor arranca,
 * negocia la version del protocolo y expone sus tools. Es lo que se rompe cuando se
 * cambia el SDK o se agrega una tool mal definida.
 *
 * Uso:  node test/mcp-smoke.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "mcp", "server.mjs");

const EXPECTED_TOOLS = [
  "gauth_diagnose",
  "gauth_publish_status",
  "gauth_list_test_users",
  "gauth_add_test_users",
  "gauth_remove_test_users",
  "gauth_get_branding",
  "gauth_fill_branding",
  "gauth_publish",
  "gauth_create_client",
  "gauth_renew_secret",
];

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
const responses = new Map();
let stderr = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  // Los mensajes van separados por saltos de linea.
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      console.error(`Respuesta no parseable: ${line.slice(0, 200)}`);
    }
  }
});

child.stderr.on("data", (d) => (stderr += d));

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

async function waitFor(id, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Sin respuesta al id ${id}. stderr: ${stderr.slice(0, 500)}`);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n        ${detail}` : ""}`);
  if (!ok) failed++;
};

try {
  // 1. initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-smoke", version: "1.0.0" },
    },
  });

  const init = await waitFor(1);
  check("initialize responde", !!init.result, JSON.stringify(init).slice(0, 300));
  check("negocia protocolVersion", !!init.result?.protocolVersion, String(init.result?.protocolVersion));
  check("declara capabilities.tools", !!init.result?.capabilities?.tools);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitFor(2);
  const tools = list.result?.tools ?? [];

  check("tools/list devuelve tools", tools.length > 0, JSON.stringify(list).slice(0, 300));

  const names = tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  check(`expone las ${EXPECTED_TOOLS.length} tools esperadas`, missing.length === 0, `faltan: ${missing}`);

  const noSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object");
  check("todas las tools tienen inputSchema valido", noSchema.length === 0, `sin schema: ${noSchema.map((t) => t.name)}`);

  const noDescription = tools.filter((t) => !t.description || t.description.length < 40);
  check(
    "todas las tools tienen descripcion util para el modelo",
    noDescription.length === 0,
    `descripcion corta: ${noDescription.map((t) => t.name)}`,
  );

  // El modelo necesita saber que 'project' es obligatorio en casi todas.
  const needsProject = tools.filter((t) => t.inputSchema?.properties?.project);
  check(
    "las tools que requieren project lo declaran",
    needsProject.length === EXPECTED_TOOLS.length,
    `${needsProject.length}/${EXPECTED_TOOLS.length}`,
  );

  console.log(`\n  tools: ${names.join(", ")}`);
} catch (err) {
  console.error(`\n  ERROR: ${err.message}`);
  failed++;
} finally {
  child.kill();
}

console.log(failed ? `\n${failed} verificacion(es) fallaron\n` : "\nMCP OK\n");
process.exit(failed ? 1 : 0);
