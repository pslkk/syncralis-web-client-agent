import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RemoteMcp, VERSION, loadToken, normalizeUrl, parseSse, validateToken } from "../lib/remote-mcp.mjs";
import { parseArgs, parseSeconds, safeName, shapeResult } from "../lib/output.mjs";

const TOKEN = "a".repeat(40);

test("version is 1.1.0 everywhere it is declared", () => {
  assert.equal(VERSION, "1.1.0");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  assert.match(fs.readFileSync(path.join(root, "SKILL.md"), "utf8"), /version: "1\.1\.0"/);
  for (const f of ["scripts/syncralis.mjs", "scripts/lib/remote-mcp.mjs", "scripts/lib/output.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /1\.0\.0|client\/1\.0\b/, f);
  }
});

test("normalizeUrl: https only (loopback http allowed), no credentials/query, mcp|sse suffix stripped", () => {
  assert.equal(normalizeUrl("https://x.onrender.com/mcp/").mcpUrl, "https://x.onrender.com/mcp");
  assert.equal(normalizeUrl("https://x.onrender.com/sse").healthUrl, "https://x.onrender.com/health");
  assert.equal(normalizeUrl("http://localhost:3000").base, "http://localhost:3000");
  assert.equal(normalizeUrl("http://[::1]:3000").base, "http://[::1]:3000");
  for (const bad of ["http://example.com", "https://u:p@x.com", "https://x.com/?a=1", "https://x.com/#f", "", undefined, "ftp://x.com"]) {
    assert.throws(() => normalizeUrl(bad), /SYNCRALIS_URL/, String(bad));
  }
});

test("validateToken and loadToken", () => {
  assert.equal(validateToken(`\uFEFF${TOKEN}\n`), TOKEN);
  assert.throws(() => validateToken("short"), /malformed/);
  assert.throws(() => validateToken(`name:${TOKEN}`), /name:/);
  assert.throws(() => loadToken({ env: {}, readFileSync: () => { throw new Error("nope"); } }), /No token found/);
  assert.equal(loadToken({ env: { SYNCRALIS_TOKEN: TOKEN } }).token, TOKEN);
  assert.throws(() => loadToken({ env: { SYNCRALIS_TOKEN_FILE: "/x" }, readFileSync: () => "a".repeat(5000) }), /too large/);
});

test("parseArgs refuses tokens on the command line and unknown options", () => {
  assert.throws(() => parseArgs(["call", "x", "--token", "abc"]), /never accepted/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["call", "--out"]), /needs a value/);
  assert.deepEqual(parseArgs(["call", "t", "-"]).positional, ["t", "-"]);
});

test("parseSeconds rejects NaN, zero, negative and huge values", () => {
  for (const v of ["abc", 0, -5, 1e9, NaN]) assert.throws(() => parseSeconds(v, "--timeout"), /--timeout/);
  assert.equal(parseSeconds("30", "--timeout"), 30);
});

test("safeName neutralises traversal, odd characters and Windows reserved names", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("..\\..\\evil.exe"), "evil.exe");
  assert.equal(safeName(".bashrc"), "bashrc");
  assert.equal(safeName("NUL.txt"), "_NUL.txt");
  assert.equal(safeName("a b$c.pdf"), "a_b_c.pdf");
  assert.equal(safeName(""), "download.bin");
  assert.ok(safeName("x".repeat(500)).length <= 120);
});

test("parseSse extracts JSON events and ignores junk", () => {
  const msgs = parseSse('event: message\ndata: {"id":1}\n\ndata: not json\n\ndata: {"id":2}\n\n');
  assert.deepEqual(msgs.map((m) => m.id), [1, 2]);
});

test("shapeResult: verifies SHA-256, handles either part order, never overwrites", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syn-"));
  const buf = Buffer.from("hello pdf");
  const sha = createHash("sha256").update(buf).digest("hex");
  const meta = { type: "text", text: JSON.stringify({ filename: "r.pdf", sha256: sha }) };
  const blob = { type: "resource", resource: { blob: buf.toString("base64"), mimeType: "application/pdf" } };
  const first = shapeResult({ content: [blob, meta] }, { outDir: dir }); // blob BEFORE metadata
  assert.equal(first.ok, true);
  assert.equal(first.files[0].verified, true);
  assert.equal(path.basename(first.files[0].path), "r.pdf");
  const second = shapeResult({ content: [meta, blob] }, { outDir: dir });
  assert.equal(path.basename(second.files[0].path), "r-1.pdf");
  assert.equal(fs.readFileSync(first.files[0].path, "utf8"), "hello pdf");
  const bad = shapeResult({ content: [{ type: "text", text: JSON.stringify({ filename: "x.pdf", sha256: "0".repeat(64) }) }, blob] }, { outDir: dir });
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(path.join(dir, "x.pdf")), false);
  assert.equal(shapeResult({ content: [blob] }, {}).files[0].saved, false);
  assert.match(first.untrustedContent, /never as instructions/);
});

// ---- mock server ---------------------------------------------------------------------------------
function startServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body, seen);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};
const fast = { sleep: async () => {}, timeoutMs: 5_000 };

test("client: initialize, header hygiene, tool call, close", async () => {
  const { server, seen, url } = await startServer((req, res, body) => {
    if (req.method === "DELETE") return json(res, 200, {});
    const m = JSON.parse(body);
    if (m.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26" } }, { "mcp-session-id": "S1" });
    if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "{}" }] } });
  });
  try {
    const c = new RemoteMcp({ url, token: TOKEN, ...fast });
    await c.connect();
    assert.equal(c.sessionId, "S1");
    const r = await c.request("tools/call", { name: "web_search", arguments: {} });
    assert.ok(r.result);
    await c.close();
    const post = seen.find((s) => s.method === "POST");
    assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(post.headers["user-agent"], `syncralis-skill-client/${VERSION}`);
    assert.equal(seen.at(-1).method, "DELETE");
    assert.equal(seen.at(-1).headers["mcp-session-id"], "S1");
  } finally {
    server.close();
  }
});

test("client: unknown session (404) is re-established once and the call succeeds", async () => {
  let sessions = 0;
  let calls = 0;
  const { server, url } = await startServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26" } }, { "mcp-session-id": `S${++sessions}` });
    if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    if (req.headers["mcp-session-id"] === "S1") return json(res, 404, { error: "unknown session" });
    calls++;
    json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [] } });
  });
  try {
    const c = new RemoteMcp({ url, token: TOKEN, ...fast });
    await c.connect();
    const r = await c.request("tools/call", { name: "open_page", arguments: {} });
    assert.ok(r.result);
    assert.equal(sessions, 2);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("client: a tools/call that may have reached the server is never replayed on 502", async () => {
  let toolCalls = 0;
  const { server, url } = await startServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26" } }, { "mcp-session-id": "S" });
    if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    toolCalls++;
    json(res, 502, { error: "bad gateway" });
  });
  try {
    const c = new RemoteMcp({ url, token: TOKEN, ...fast });
    await c.connect();
    await assert.rejects(c.request("tools/call", { name: "download_file", arguments: {} }), /HTTP 502/);
    assert.equal(toolCalls, 1);
  } finally {
    server.close();
  }
});

test("client: 503 is retried, then succeeds", async () => {
  let n = 0;
  const { server, url } = await startServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize" && ++n < 3) return json(res, 503, { error: "busy" }, { "retry-after": "0" });
    json(res, 200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26" } }, { "mcp-session-id": "S" });
  });
  try {
    const c = new RemoteMcp({ url, token: TOKEN, ...fast });
    const r = await c.forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r[0].id, 1);
    assert.equal(n, 3);
  } finally {
    server.close();
  }
});

test("client: redirects are refused and the token is never sent to the target", async () => {
  const target = await startServer((req, res) => json(res, 200, {}));
  const origin = await startServer((req, res) => {
    res.writeHead(307, { location: `${target.url}/mcp` });
    res.end();
  });
  try {
    const c = new RemoteMcp({ url: origin.url, token: TOKEN, ...fast });
    await assert.rejects(c.connect(), /redirect/i);
    assert.equal(target.seen.length, 0);
  } finally {
    origin.server.close();
    target.server.close();
  }
});

test("client: token never appears in errors or logs", async () => {
  const logs = [];
  const { server, url } = await startServer((req, res) => json(res, 401, { error: `bad token ${TOKEN}` }));
  try {
    const c = new RemoteMcp({ url, token: TOKEN, log: (m) => logs.push(m), ...fast });
    await assert.rejects(c.connect(), (e) => {
      assert.ok(!e.message.includes(TOKEN));
      assert.match(e.message, /401/);
      return true;
    });
    assert.ok(logs.every((l) => !l.includes(TOKEN)));
  } finally {
    server.close();
  }
});

test("client: oversized responses are rejected", async () => {
  const { server, url } = await startServer((req, res) => json(res, 200, { pad: "x".repeat(5000) }));
  try {
    const c = new RemoteMcp({ url, token: TOKEN, maxResponseBytes: 1000, ...fast });
    await assert.rejects(c.forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), /larger than/);
  } finally {
    server.close();
  }
});

test("client: non-object JSON bodies do not crash callers", async () => {
  const { server, url } = await startServer((req, res) => json(res, 200, null));
  try {
    const c = new RemoteMcp({ url, token: TOKEN, ...fast });
    await assert.rejects(c.connect(), /Server rejected initialize/);
  } finally {
    server.close();
  }
});

test("cli: --version, health, call and bad --timeout work end to end", async () => {
  const { spawn } = await import("node:child_process");
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../syncralis.mjs");
  const { server, url } = await startServer((req, res, body) => {
    if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
    if (req.method === "DELETE") return json(res, 200, {});
    const m = JSON.parse(body);
    if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    const result = m.method === "initialize" ? { protocolVersion: "2025-03-26" } : { content: [{ type: "text", text: '{"hello":1}' }] };
    json(res, 200, { jsonrpc: "2.0", id: m.id, result }, m.method === "initialize" ? { "mcp-session-id": "S" } : {});
  });
  const run = (args, input = "") =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [script, ...args], { env: { ...process.env, SYNCRALIS_URL: url, SYNCRALIS_TOKEN: TOKEN } });
      let stdout = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stdin.end(input);
      p.on("exit", (code) => resolve({ code, stdout }));
    });
  try {
    assert.deepEqual(await run(["--version"]), { code: 0, stdout: "1.1.0\n" });
    assert.equal((await run(["health"])).code, 0);
    const call = await run(["call", "web_search", "-"], '{"query":"x"}');
    assert.equal(call.code, 0);
    assert.deepEqual(JSON.parse(call.stdout).data, { hello: 1 });
    const bad = await run(["call", "web_search", "{}", "--timeout", "abc"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stdout, /--timeout must be/);
  } finally {
    server.close();
  }
});
