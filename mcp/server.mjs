#!/usr/bin/env node
/**
 * Servidor MCP para google-oauth-cli.
 *
 * PARA QUE SIRVE
 * Claude Code y los agentes con shell pueden correr el CLI directamente. Pero Claude
 * Desktop, ChatGPT y otras apps de chat NO ejecutan comandos: solo pueden llamar
 * herramientas que se les expongan. MCP (Model Context Protocol) es el camino comun
 * para todos ellos, asi que este servidor es el que hace que la herramienta sea usable
 * desde cualquier cliente.
 *
 * POR QUE ES UN ADAPTADOR Y NO UNA REIMPLEMENTACION
 * Cada tool lanza el CLI y devuelve su JSON. Reimplementar la logica aca duplicaria el
 * codigo y las dos copias se irian separando. Una sola fuente de verdad: cli.mjs.
 *
 * REGLA CRITICA
 * Un servidor MCP por stdio NO puede escribir nada en stdout que no sea JSON-RPC: el
 * cliente intentaria parsearlo como mensaje del protocolo y se rompe. Todo log va por
 * console.error (stderr), que el cliente ignora.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

/** Corre un comando del CLI y devuelve su salida JSON. */
function runCli(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      err += `\nTimeout tras ${timeoutMs}ms. Probablemente Chrome este esperando un login manual.`;
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      try {
        resolve({ code, data: JSON.parse(text), stderr: err.trim() });
      } catch {
        resolve({ code, data: null, raw: text, stderr: err.trim() });
      }
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, data: null, stderr: String(e) });
    });
  });
}

/**
 * Envuelve el resultado de un comando en una respuesta MCP.
 *
 * `isError` sigue el codigo de salida, no el campo `ok`: un bloqueo de Google (por
 * ejemplo, que falte la politica de privacidad) es un resultado legitimo y util, no un
 * fallo de la herramienta. Marcarlo como error confunde al modelo.
 */
function reply({ code, data, raw, stderr }) {
  const payload = data ?? { ok: false, error: raw || "Sin salida JSON", stderr };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2) + (stderr ? `\n\n[stderr]\n${stderr}` : ""),
      },
    ],
    isError: code !== 0,
  };
}

const project = z.string().describe("Google Cloud project ID, e.g. my-app-492517");

const server = new McpServer({
  name: "google-oauth-cli",
  version: "1.0.0",
});

// ─── Diagnostico ──────────────────────────────────────────────────────────────

server.registerTool(
  "gauth_diagnose",
  {
    title: "Diagnose Google OAuth setup",
    description:
      "Full health check of a Google OAuth setup: publish state, missing branding fields, " +
      "test users, and a specific fix for every blocker found. Call this FIRST for any " +
      "'Google login not working' problem. Returns blockers[] with stable codes: " +
      "NO_TEST_USERS, NOT_PUBLISHED, BRANDING_URLS_MISSING, BRANDING_CONTACT_MISSING. " +
      "An empty blockers array means OAuth is not the cause of the login failure.",
    inputSchema: { project },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ project: p }) => reply(await runCli(["diagnose", "--project", p])),
);

server.registerTool(
  "gauth_publish_status",
  {
    title: "Get OAuth publishing status",
    description:
      "Whether the OAuth app is in Testing or Production, the test-user limit, and whether " +
      "the Publish button is currently enabled. Apps in Testing are capped at 100 users " +
      "over the entire lifetime of the app, not per year.",
    inputSchema: { project },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ project: p }) => reply(await runCli(["status", "--project", p])),
);

// ─── Usuarios de prueba ───────────────────────────────────────────────────────

server.registerTool(
  "gauth_list_test_users",
  {
    title: "List OAuth test users",
    description:
      "Email addresses allowed to sign in while the app is in Testing mode. An empty list " +
      "means every sign-in is rejected by Google BEFORE it reaches the application, so the " +
      "application logs stay empty and it looks like a code bug.",
    inputSchema: { project },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ project: p }) => reply(await runCli(["test-users", "list", "--project", p])),
);

server.registerTool(
  "gauth_add_test_users",
  {
    title: "Add OAuth test users",
    description:
      "Add emails to the consent screen's test-user allowlist. REQUIRED while the app is in " +
      "Testing: with zero test users Google rejects every login before the request reaches " +
      "the application, leaving the application logs completely empty.",
    inputSchema: {
      project,
      emails: z
        .array(z.string())
        .min(1)
        .describe("Email addresses to allow. Each must belong to a Google account."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ project: p, emails }) =>
    reply(await runCli(["test-users", "add", "--project", p, "--emails", emails.join(",")])),
);

server.registerTool(
  "gauth_remove_test_users",
  {
    title: "Remove OAuth test users",
    description: "Remove emails from the consent screen's test-user allowlist.",
    inputSchema: {
      project,
      emails: z.array(z.string()).min(1).describe("Email addresses to remove."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ project: p, emails }) =>
    reply(await runCli(["test-users", "remove", "--project", p, "--emails", emails.join(",")])),
);

// ─── Marca y publicacion ──────────────────────────────────────────────────────

server.registerTool(
  "gauth_get_branding",
  {
    title: "Read OAuth branding fields",
    description:
      "Current values of the consent screen branding page, and which required fields are " +
      "empty. Google requires home page, privacy policy, terms of service and a developer " +
      "contact email before an app can be published.",
    inputSchema: { project },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ project: p }) => reply(await runCli(["branding", "--project", p])),
);

server.registerTool(
  "gauth_fill_branding",
  {
    title: "Set OAuth branding fields",
    description:
      "Set the consent screen branding fields. Google REQUIRES home page, privacy policy, " +
      "terms of service and a developer contact email before the app can be published, and " +
      "those URLs must be publicly reachable (a 404 is rejected). If those pages do not " +
      "exist yet, creating them is a prerequisite: the save will silently not persist " +
      "otherwise. The result reports per-field whether each value actually persisted.",
    inputSchema: {
      project,
      homepage: z.string().optional().describe("Public home page URL"),
      privacy: z.string().optional().describe("Public privacy policy URL"),
      terms: z.string().optional().describe("Public terms of service URL"),
      contact: z.string().optional().describe("Developer contact email"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ project: p, homepage, privacy, terms, contact }) => {
    const args = ["branding", "--project", p];
    if (homepage) args.push("--homepage", homepage);
    if (privacy) args.push("--privacy", privacy);
    if (terms) args.push("--terms", terms);
    if (contact) args.push("--contact", contact);
    return reply(await runCli(args));
  },
);

server.registerTool(
  "gauth_publish",
  {
    title: "Publish the OAuth app",
    description:
      "Publish the OAuth app so it leaves Testing mode and is no longer capped at 100 users " +
      "over its entire lifetime. Returns blocked=true when the branding page is incomplete. " +
      "That is a server-side precondition, so do NOT retry it: complete the branding first.",
    inputSchema: { project },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ project: p }) => reply(await runCli(["publish", "--project", p])),
);

// ─── Credenciales ─────────────────────────────────────────────────────────────

server.registerTool(
  "gauth_create_client",
  {
    title: "Create an OAuth client",
    description:
      "Create a Google OAuth 2.0 Web Client (client ID and secret), configuring the consent " +
      "screen if it does not exist yet. The GCP project must already exist. The first run " +
      "opens Chrome for a one-time interactive Google sign-in and can take up to 3 minutes. " +
      "IMPORTANT: the response contains a client secret. Store it directly in the project " +
      "environment (Auth.js v5: AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET) and never echo it into " +
      "a repository file, a log or a chat message.",
    inputSchema: {
      project,
      name: z.string().describe("App name shown on the consent screen"),
      redirect_uri: z
        .string()
        .describe("OAuth redirect URI. For Auth.js v5: https://<domain>/api/auth/callback/google"),
      email: z.string().describe("Support email shown on the consent screen"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ project: p, name, redirect_uri, email }) =>
    reply(
      await runCli([
        "create",
        "--project",
        p,
        "--name",
        name,
        "--redirect",
        redirect_uri,
        "--email",
        email,
      ]),
    ),
);

server.registerTool(
  "gauth_renew_secret",
  {
    title: "Rotate the OAuth client secret",
    description:
      "Add a new client secret to an existing OAuth client and return it. Use when the " +
      "secret was lost, leaked or needs rotating. The previous secret keeps working until " +
      "it is deleted in the console, so there is no downtime. The response contains a " +
      "secret: never echo it into a repository file, a log or a chat message.",
    inputSchema: { project },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ project: p }) => reply(await runCli(["renew", "--project", p])),
);

// ─── Arranque ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// A stderr, nunca a stdout: stdout es del protocolo.
console.error("google-oauth-cli MCP server listo (stdio).");
