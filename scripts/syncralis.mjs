#!/usr/bin/env node
// Command-line client and stdio MCP bridge for a hosted syncralis-web-agent (for example on Render).
//
//   node syncralis.mjs health
//   node syncralis.mjs tools
//   node syncralis.mjs call <tool> '<json-arguments>' [--out DIR]
//   node syncralis.mjs bridge            (stdio MCP server that proxies to the hosted server)
//
// Configuration (environment only; the token is never accepted as an argument):
//   SYNCRALIS_URL         https://<service>.onrender.com
//   SYNCRALIS_TOKEN       the bearer token   (or SYNCRALIS_TOKEN_FILE, default ~/.config/syncralis/token)
import readline from "node:readline";
import { RemoteMcp, RemoteError, VERSION, loadToken, loadUrl, normalizeUrl, waitForService } from "./lib/remote-mcp.mjs";
import { clean, parseArgs, parseSeconds, shapeResult } from "./lib/output.mjs";

const MAX_ARGS_BYTES = 1_000_000;

const HELP = `syncralis ${VERSION}: client for a hosted syncralis-web-agent

Usage:
  node syncralis.mjs health                       check the service (no token needed)
  node syncralis.mjs tools                        list the server's tools
  node syncralis.mjs call <tool> [json|-]         call a tool; arguments as JSON, or "-" to read stdin
  node syncralis.mjs bridge                       run as a stdio MCP server proxying to the hosted one

Options:
  --url <url>      server URL (default: $SYNCRALIS_URL, else the first line of ~/.config/syncralis/url)
  --out <dir>      save files returned by fetch_download into this directory
  --raw            print the raw MCP result instead of the simplified form
  --timeout <sec>  per-request timeout (default 150)
  --no-wake        do not wait for a sleeping (free plan) service to start
  --debug          log requests to stderr (the token is always redacted)
  --version        print the client version

Environment:
  SYNCRALIS_URL | SYNCRALIS_URL_FILE, SYNCRALIS_TOKEN | SYNCRALIS_TOKEN_FILE, SYNCRALIS_WAKE_TIMEOUT_SEC (default 90)

Exit codes: 0 ok, 1 the tool/server reported an error, 2 usage, configuration, authentication or network error.
`;

const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n");

async function readStdin(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const c of process.stdin) {
    total += c.length;
    if (total > maxBytes) throw new RemoteError("Arguments on stdin are too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runBridge(client, { wakeMs, noWake, log }) {
  const ready = noWake ? Promise.resolve() : client.wake({ timeoutMs: wakeMs });
  let gate = Promise.resolve();
  const inflight = new Set();
  const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  process.stdout.on("error", () => process.exit(0));

  const handle = async (msg) => {
    const isRequest = msg && typeof msg === "object" && msg.id !== undefined && typeof msg.method === "string";
    const run = async () => {
      await ready;
      for (const r of await client.forward(msg)) write(r);
    };
    try {
      if (msg?.method === "initialize") {
        const p = run();
        gate = p.catch(() => {});
        await p;
      } else {
        await gate;
        await run();
      }
    } catch (err) {
      const message = clean(err instanceof RemoteError ? err.message : "Internal bridge error");
      if (isRequest) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
      else log(`dropped ${msg?.method ?? "message"}: ${message}`);
    }
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      log("ignored a line that is not JSON");
      return;
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      const p = handle(m).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });
  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 10_000).unref())]);
      await client.close();
      process.exit(0);
    })();
    return stopping;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise((resolve) => rl.once("close", resolve));
  await stop();
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || !cmd || cmd === "help") {
    process.stdout.write(HELP);
    return cmd || flags.help ? 0 : 2;
  }
  if (Number(process.versions.node.split(".")[0]) < 18) throw new RemoteError("Node.js 18 or newer is required");

  const debug = flags.debug || process.env.SYNCRALIS_DEBUG === "1";
  const log = (m) => process.stderr.write(`[syncralis] ${m}\n`);
  const url = loadUrl({ flagUrl: flags.url });
  const wakeMs = parseSeconds(process.env.SYNCRALIS_WAKE_TIMEOUT_SEC ?? 90, "SYNCRALIS_WAKE_TIMEOUT_SEC") * 1000;
  const timeoutMs = parseSeconds(flags.timeout ?? 150, "--timeout") * 1000;

  if (cmd === "health") {
    normalizeUrl(url);
    const up = await waitForService({ url, timeoutMs: flags.noWake ? 1_000 : wakeMs, log });
    out({ ok: up, status: up ? "up" : "unreachable_or_not_a_syncralis_service" });
    return up ? 0 : 2;
  }

  if (!["tools", "call", "bridge"].includes(cmd)) throw new RemoteError(`Unknown command "${cmd}". Run with --help.`);

  const { token, warnings } = loadToken();
  for (const w of warnings) log(`warning: ${w}`);
  const client = new RemoteMcp({ url, token, timeoutMs, log: debug ? log : (m) => (/wake|Session expired/.test(m) ? log(m) : undefined) });

  if (cmd === "bridge") {
    await runBridge(client, { wakeMs, noWake: flags.noWake, log });
    return 0;
  }

  let toolName;
  let args = {};
  if (cmd === "call") {
    toolName = positional[0];
    if (!toolName || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(toolName)) throw new RemoteError("Usage: call <tool_name> [json-arguments | -]");
    let raw = positional[1];
    if (raw === "-") raw = await readStdin(MAX_ARGS_BYTES);
    if (raw !== undefined && Buffer.byteLength(raw) > MAX_ARGS_BYTES) throw new RemoteError("Arguments are too large");
    if (raw !== undefined && raw.trim() !== "") {
      try {
        args = JSON.parse(raw);
      } catch {
        throw new RemoteError("The arguments are not valid JSON");
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw new RemoteError("The arguments must be a JSON object");
    }
  }

  try {
    if (!flags.noWake) await client.wake({ timeoutMs: wakeMs });
    await client.connect();
    if (cmd === "tools") {
      const reply = await client.request("tools/list", {});
      if (reply.error) {
        out({ ok: false, error: clean(reply.error.message) });
        return 1;
      }
      out({ ok: true, tools: (reply.result?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      return 0;
    }
    const reply = await client.request("tools/call", { name: toolName, arguments: args });
    if (reply.error) {
      out({ ok: false, error: clean(reply.error.message), code: reply.error.code });
      return 1;
    }
    const shaped = shapeResult(reply.result ?? {}, { outDir: flags.out, raw: flags.raw });
    out(shaped);
    return shaped.ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof RemoteError) {
      out({ ok: false, error: err.message });
    } else {
      out({ ok: false, error: "Unexpected client error" });
      if (process.env.SYNCRALIS_DEBUG === "1") process.stderr.write(`${err?.stack || err}\n`);
    }
    process.exitCode = 2;
  }
);
