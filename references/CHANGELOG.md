# Changelog

## 1.1.0

Every version string (skill metadata, client, MCP `clientInfo`, `User-Agent`) is now 1.1.0 and comes from one constant (`VERSION` in `scripts/lib/remote-mcp.mjs`). `node scripts/syncralis.mjs --version` prints it.

### Fixed
- Downloaded files were saved unverified (and could mis-name) when the file part arrived before its metadata part; results are now processed in two passes.
- `--timeout abc` or `SYNCRALIS_WAKE_TIMEOUT_SEC=abc` produced a NaN timeout and an obscure crash; both are validated (1-3600 s) with a clear error.
- A server reply of `null` or a non-object JSON value caused an "Unexpected client error"; non-object messages are now discarded.
- Bridge shutdown could run twice (SIGINT then stdin close) and could hang on a stuck request; it is now idempotent with a 10 s ceiling.
- Windows reserved device names (`NUL.txt`, `CON`) and trailing dots/spaces in server-supplied filenames are neutralised.
- A UTF-8 BOM in the token or URL file no longer makes a valid token look malformed; oversized token files are rejected.
- `waitForService` no longer sleeps past its own deadline.
- `call` accepts tool names containing upper-case letters, `.` and `-`.
- Tool table and description now list `fetch_download`; the "Network access" table row had a missing column.
- `--debug` now actually logs request methods and statuses (never headers or bodies).

### Added
- `--version` flag, dependency-free test suite (`scripts/test/client.test.mjs`, 17 tests), `LICENSE`, this changelog.
