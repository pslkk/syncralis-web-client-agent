import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "1.1.0";
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_PRECONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export class RemoteError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "RemoteError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    throw new RemoteError("SYNCRALIS_URL is missing or not a valid URL (set it, or put it in ~/.config/syncralis/url; example: https://my-service.onrender.com)");
  }
  if (u.username || u.password) throw new RemoteError("SYNCRALIS_URL must not contain credentials; the token is configured separately");
  if (u.search || u.hash) throw new RemoteError("SYNCRALIS_URL must not contain a query string or fragment");
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new RemoteError("SYNCRALIS_URL must use https:// (plain http is only allowed for localhost), so the token is never sent unencrypted");
  }
  const basePath = u.pathname.replace(/\/+$/, "").replace(/\/(mcp|sse)$/, "");
  const base = u.origin + basePath;
  return { base, mcpUrl: `${base}/mcp`, healthUrl: `${base}/health` };
}

/** Server URL: --url flag, else SYNCRALIS_URL, else the first line of SYNCRALIS_URL_FILE / ~/.config/syncralis/url. */
export function loadUrl({ flagUrl, env = process.env, readFileSync = fs.readFileSync } = {}) {
  if (flagUrl) return flagUrl;
  if (env.SYNCRALIS_URL) return env.SYNCRALIS_URL;
  const file = env.SYNCRALIS_URL_FILE || path.join(os.homedir(), ".config", "syncralis", "url");
  try {
    return stripBom(readFileSync(file, "utf8").slice(0, 4096)).split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

function stripBom(text) {
  return String(text ?? "").replace(/^\uFEFF/, "");
}

export function validateToken(raw) {
  const token = stripBom(raw).trim();
  if (!TOKEN_RE.test(token)) {
    const hint = token.includes(":") ? " Use only the token itself, not the `name:` prefix used in MCP_AUTH_TOKENS." : "";
    throw new RemoteError(`The token is missing or malformed (expected 32-256 characters of A-Z a-z 0-9 . _ ~ + / = -).${hint}`);
  }
  return token;
}

/** Token from SYNCRALIS_TOKEN, else from SYNCRALIS_TOKEN_FILE / ~/.config/syncralis/token. */
export function loadToken({ env = process.env, readFileSync = fs.readFileSync, statSync = fs.statSync } = {}) {
  const warnings = [];
  if (env.SYNCRALIS_TOKEN) return { token: validateToken(env.SYNCRALIS_TOKEN), warnings };
  const file = env.SYNCRALIS_TOKEN_FILE || path.join(os.homedir(), ".config", "syncralis", "token");
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    throw new RemoteError(`No token found. Set SYNCRALIS_TOKEN, or put the token in ${file} (chmod 600).`);
  }
  if (content.length > 4096) throw new RemoteError(`${file} is too large to be a token file`);
  try {
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
      warnings.push(`Token file ${file} is readable by other users; run: chmod 600 "${file}"`);
    }
  } catch {
    /* permission check is best effort */
  }
  return { token: validateToken(content), warnings };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitize(text, max = 200) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new RemoteError(`Response is larger than the ${maxBytes}-byte limit`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RemoteError(`Response is larger than the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* ignore non-JSON events */
    }
  }
  return out;
}

export async function waitForService({ url, isHealthUrl = false, fetchImpl = globalThis.fetch, timeoutMs = 90_000, intervalMs = 2_000, sleep = defaultSleep, log = () => {}, userAgent = `syncralis-skill-client/${VERSION}` }) {
  const healthUrl = isHealthUrl ? url : normalizeUrl(url).healthUrl;
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      const res = await fetchImpl(healthUrl, {
        method: "GET",
        redirect: "error",
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(Math.min(15_000, Math.max(1_000, deadline - Date.now()))),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status === 200) return true;
      if (res.status === 404 || res.status === 401 || res.status === 403) return false;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) return false;
    if (!announced) {
      log("Waiting for the service to wake up (free plans cold-start; this can take about a minute)...");
      announced = true;
    }
    await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
  }
}

export class RemoteMcp {
  #mcpUrl;
  #healthUrl;
  #token;
  #fetch;
  #timeoutMs;
  #maxBytes;
  #maxRetries;
  #sleep;
  #log;
  #ua;
  #sessionId = null;
  #protocol = null;
  #initParams = null;
  #initializedSent = false;
  #reinit = null;
  #reinitCount = 0;

  constructor({
    url,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = 150_000,
    maxResponseBytes = 25 * 1024 * 1024,
    maxRetries = 3,
    sleep = defaultSleep,
    log = () => {},
    userAgent = `syncralis-skill-client/${VERSION}`,
  }) {
    const { mcpUrl, healthUrl } = normalizeUrl(url);
    this.#mcpUrl = mcpUrl;
    this.#healthUrl = healthUrl;
    this.#token = validateToken(token);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxBytes = maxResponseBytes;
    this.#maxRetries = maxRetries;
    this.#sleep = sleep;
    this.#ua = userAgent;
    this.#log = (m) => log(String(m).split(this.#token).join("[redacted]"));
  }

  get sessionId() {
    return this.#sessionId;
  }

  async wake({ timeoutMs = 90_000, intervalMs = 2_000 } = {}) {
    return waitForService({ url: this.#healthUrl, isHealthUrl: true, fetchImpl: this.#fetch, timeoutMs, intervalMs, sleep: this.#sleep, log: this.#log, userAgent: this.#ua });
  }

  async forward(message) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      throw new RemoteError("Not a JSON-RPC request or notification");
    }
    if (message.method === "initialize") {
      this.#initParams = message.params ?? {};
      this.#sessionId = null;
      this.#protocol = null;
      this.#initializedSent = false;
    }
    const responses = await this.#send(message, {});
    if (message.method === "notifications/initialized") this.#initializedSent = true;
    return responses;
  }

  async connect(clientInfo = { name: "syncralis-skill-client", version: VERSION }) {
    const id = "init-1";
    const responses = await this.forward({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo },
    });
    const reply = responses.find((m) => m.id === id);
    if (!reply || reply.error || !reply.result) {
      throw new RemoteError(`Server rejected initialize: ${sanitize(reply?.error?.message) || "no result"}`);
    }
    await this.forward({ jsonrpc: "2.0", method: "notifications/initialized" });
    return reply.result;
  }

  async request(method, params, id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
    const responses = await this.forward({ jsonrpc: "2.0", id, method, params });
    const reply = responses.find((m) => m.id === id);
    if (!reply) throw new RemoteError(`No response received for ${method}`);
    return reply;
  }

  async close() {
    const sid = this.#sessionId;
    this.#sessionId = null;
    if (!sid) return;
    try {
      const res = await this.#fetch(this.#mcpUrl, {
        method: "DELETE",
        redirect: "error",
        headers: { authorization: `Bearer ${this.#token}`, "mcp-session-id": sid, "user-agent": this.#ua },
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      /* best effort: the server expires idle sessions anyway */
    }
  }

  async #post(message) {
    const sidUsed = this.#sessionId;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.#token}`,
      "user-agent": this.#ua,
    };
    if (sidUsed) headers["mcp-session-id"] = sidUsed;
    if (this.#protocol && message.method !== "initialize") headers["mcp-protocol-version"] = this.#protocol;
    const res = await this.#fetch(this.#mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      redirect: "error", // never follow a redirect with the token attached
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    return { res, sidUsed };
  }

  #networkError(err) {
    const code = err?.cause?.code || err?.code;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return new RemoteError(`Request timed out after ${Math.round(this.#timeoutMs / 1000)}s`, { code: "TIMEOUT" });
    }
    if (/redirect/i.test(String(err?.cause?.message || err?.message))) {
      return new RemoteError("The server answered with a redirect. Refusing to follow it so the token is not forwarded; use the exact https URL of the service.", { code: "REDIRECT" });
    }
    if (err instanceof RemoteError) return err;
    return new RemoteError(`Cannot reach the server (${sanitize(code || err?.message || "network error", 60)})`, { code: code || "NETWORK" });
  }

  async #httpError(res) {
    let detail = "";
    try {
      const body = await readCapped(res, 64 * 1024);
      try {
        const j = JSON.parse(body);
        detail = sanitize(typeof j.error === "string" ? j.error : j.error?.message);
      } catch {
        detail = "";
      }
    } catch {
      /* ignore */
    }
    const s = res.status;
    const base =
      s === 401 ? "Authentication failed (HTTP 401): the token does not match any token in the server's MCP_AUTH_TOKENS"
      : s === 403 ? "Request rejected (HTTP 403): the Host/Origin is not allowed by the server (check ALLOWED_HOSTS)"
      : s === 404 ? "Not found (HTTP 404): check SYNCRALIS_URL"
      : s === 413 ? "Request too large (HTTP 413)"
      : s === 415 ? "Unsupported content type (HTTP 415)"
      : s === 429 ? "Rate limited by the server (HTTP 429)"
      : s === 503 ? "Server is busy or shutting down (HTTP 503)"
      : `Server error (HTTP ${s})`;
    return new RemoteError(detail && s !== 401 ? `${base}: ${detail}` : base, { status: s });
  }

  async #send(message, { noReinit = false } = {}) {
    const isToolCall = message.method === "tools/call";
    let attempt = 0;
    let reinitialized = false;
    for (;;) {
      if (!noReinit && this.#reinit) await this.#reinit;
      let result;
      try {
        result = await this.#post(message);
      } catch (err) {
        const code = err?.cause?.code || err?.code;
        const safeToRetry = SAFE_PRECONNECT_CODES.has(code) || (!isToolCall && code === "ECONNRESET");
        if (safeToRetry && attempt < this.#maxRetries) {
          await this.#sleep(Math.min(8_000, 1_000 * 2 ** attempt++));
          continue;
        }
        throw this.#networkError(err);
      }
      const { res, sidUsed } = result;
      this.#log(`POST ${message.method} -> HTTP ${res.status}`);

      if (res.status === 404 && sidUsed && message.method !== "initialize" && !noReinit && !reinitialized) {
        await res.body?.cancel().catch(() => {});
        reinitialized = true;
        if (this.#reinit) await this.#reinit;
        else if (this.#sessionId === sidUsed) await this.#reinitialize();
        continue;
      }

      const retryable = res.status === 503 || res.status === 429 || ((res.status === 502 || res.status === 504) && !isToolCall);
      if (retryable && attempt < this.#maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        await res.body?.cancel().catch(() => {});
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(30_000, ra * 1_000) : Math.min(8_000, 1_000 * 2 ** attempt);
        attempt += 1;
        await this.#sleep(waitMs);
        continue;
      }

      if (res.status >= 400) throw await this.#httpError(res);
      return this.#parse(res, message);
    }
  }

  async #parse(res, message) {
    const sid = res.headers.get("mcp-session-id");
    if (message.method === "initialize" && sid) this.#sessionId = sid;
    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const text = await readCapped(res, this.#maxBytes);
    let messages;
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      messages = parseSse(text);
    } else {
      try {
        messages = [JSON.parse(text)];
      } catch {
        throw new RemoteError("Server returned a response that is not valid JSON");
      }
    }
    messages = messages.flat().filter((m) => m && typeof m === "object" && !Array.isArray(m));
    if (message.method === "initialize") {
      const reply = messages.find((m) => m.id === message.id && m.result);
      if (typeof reply?.result?.protocolVersion === "string") this.#protocol = reply.result.protocolVersion;
    }
    return messages;
  }

  async #reinitialize() {
    if (!this.#initParams) throw new RemoteError("The session expired and cannot be re-established because it was never initialized");
    this.#reinit ??= (async () => {
      this.#sessionId = null;
      this.#protocol = null;
      const id = `reinit-${++this.#reinitCount}`;
      this.#log("Session expired on the server; re-establishing it.");
      const msgs = await this.#send({ jsonrpc: "2.0", id, method: "initialize", params: this.#initParams }, { noReinit: true });
      if (!msgs.some((m) => m.id === id && m.result)) throw new RemoteError("The server rejected re-initialization");
      if (this.#initializedSent) await this.#send({ jsonrpc: "2.0", method: "notifications/initialized" }, { noReinit: true });
    })().finally(() => {
      this.#reinit = null;
    });
    return this.#reinit;
  }
}
