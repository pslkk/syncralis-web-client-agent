# Hosted syncralis-web-agent: connecting from agents

This file covers the hosted (HTTP) deployment and the bundled client, `scripts/syncralis.mjs`. The client is a single
dependency-free Node.js 18+ script; nothing needs to be installed.

## 1. One-time setup

1. To obtain your Server URL and authentication token, please reach out to the developer at **[email](mailto:coregravity0.0.0@protonmail.com)**
2. Store the token in a private file (bash; the prompt hides what you type):

```bash
umask 077; mkdir -p ~/.config/syncralis
read -rsp "Token: " T; printf '%s' "$T" > ~/.config/syncralis/token; unset T
```

3. Tell the client the URL. The URL is not a secret. Either put it in a file (works everywhere the agent can read your
   home directory, no environment setup needed):

```bash
printf '%s\n' "https://my-service.onrender.com" > ~/.config/syncralis/url
```

   or export it where your agent runs (shell profile, or the agent's environment setting):

```bash
export SYNCRALIS_URL="https://my-service.onrender.com"
# optional: export SYNCRALIS_TOKEN_FILE="$HOME/.config/syncralis/token"   (this is the default)
```

4. Check it: `node scripts/syncralis.mjs --version`, then `health`, then `tools`.

Windows PowerShell: `$env:SYNCRALIS_URL = "https://..."` and `$env:SYNCRALIS_TOKEN = Read-Host "Token"` for the current session only.

## 2. Install the skill

Unzip the skill folder (it must stay named `syncralis-web-agent`) into your agent's skills directory:

| Agent | Directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| OpenClaw | `~/.openclaw/skills/` |
| Others (Codex CLI, Cursor, Gemini CLI, ...) | the skills directory documented for that agent |

Start a new session so the skill loads.

## 3. Optional: expose the hosted tools as a native MCP server

Agents that speak MCP can use the bridge. It is a stdio server that forwards each message to the hosted server with the
bearer header, re-establishes the session transparently if the server restarted, and closes the session on exit.
Keep the token out of config files by pointing at the token file.

Claude Code:

```bash
claude mcp add syncralis-hosted \
  --env SYNCRALIS_URL=https://my-service.onrender.com \
  --env SYNCRALIS_TOKEN_FILE="$HOME/.config/syncralis/token" \
  -- node "$HOME/.claude/skills/syncralis-web-agent/scripts/syncralis.mjs" bridge
```

Cursor, OpenClaw and other clients that use an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "syncralis-hosted": {
      "command": "node",
      "args": ["/home/YOU/.claude/skills/syncralis-web-agent/scripts/syncralis.mjs", "bridge"],
      "env": {
        "SYNCRALIS_URL": "https://my-service.onrender.com",
        "SYNCRALIS_TOKEN_FILE": "/home/YOU/.config/syncralis/token"
      }
    }
  }
}
```

Use absolute paths in JSON configs. Clients that can send custom HTTP headers natively may instead connect straight to
`https://<service>/mcp` with `Authorization: Bearer <token>`; the bridge is for clients that cannot.

## 4. Environment reference

| Variable | Meaning |
|---|---|
| `SYNCRALIS_URL` | Service URL (or the first line of `SYNCRALIS_URL_FILE`, default `~/.config/syncralis/url`). `https://` is required (plain `http://` only for `localhost`). A trailing `/mcp` or `/sse` is accepted. No credentials, query string, or fragment. |
| `SYNCRALIS_TOKEN` | The bearer token (32-256 characters of `A-Z a-z 0-9 . _ ~ + / = -`). |
| `SYNCRALIS_TOKEN_FILE` | File containing the token. Default `~/.config/syncralis/token`. A warning is printed if other users can read it. |
| `SYNCRALIS_WAKE_TIMEOUT_SEC` | How long to wait for a sleeping service (default 90; 1-3600). |
| `SYNCRALIS_DEBUG=1` | Log request methods and HTTP statuses to stderr (never headers or bodies; the token is always redacted). |

## 5. Security properties of the client

- The token travels only in the `Authorization` header, only over HTTPS (or loopback), and only to the configured host.
- Redirects are refused, so a misconfigured or hijacked URL cannot make the client forward the token elsewhere.
- The token is never accepted as an argument (visible in process lists and shell history), never logged, and never appears in error output.
- `/health` is polled without any credential.
- Responses are size-capped, every request has a timeout, and failed requests are retried only when that cannot repeat a side effect: connection failures before a request is sent, `503`/`429`, and (for read-only protocol messages) `502`/`504`. A `tools/call` that may have reached the server is never replayed, except after a `404 session not found`, where the server did not process it.
- Downloaded files are checked against the server-reported SHA-256 before anything is written, saved with a sanitized name and mode `0600`, and never overwrite an existing file.
- The script has no dependencies, spawns no processes, evaluates no dynamic code, and reads only the token file and stdin.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Authentication failed (HTTP 401)` | Token wrong, or removed from `MCP_AUTH_TOKENS`. Use only the part after `name:`. |
| `Request rejected (HTTP 403)` | The URL's host is not in the server's `ALLOWED_HOSTS` (custom domain), or an `Origin` header is being added by a proxy. |
| `The server answered with a redirect` | The URL is not the service's exact `https://` address (for example `http://` or a vanity domain that redirects). Use the final URL. |
| `Cannot reach the server (ENOTFOUND)` | Wrong hostname or no network. |
| First command takes ~1 minute | Free-plan cold start; the client polls `/health` until the service is up. |
| `HTTP 503` repeatedly | Server at its session or browser-task limit, or restarting. Wait and retry. |
| `SHA-256 mismatch` | The file changed or was corrupted in transit; it was not saved. Download again. |
| `Request timed out after 150s` | Slow target site. Increase with `--timeout 300` or choose a different source. |

## 7. Rotating the token

Add a new `name2:token2` to the server's `MCP_AUTH_TOKENS` (the server accepts several at once), update the client's token
file, then remove the old entry from the server.

## 8. Development

The client has no dependencies. Run its tests (Node.js 18+; they use a loopback mock server and need no network) with:

```bash
node --test scripts/test/client.test.mjs
```
