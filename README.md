# desk-tools-local-proxy

A tiny **local** WebSocket-to-SSH bridge for the [Desk-tools](https://zafrem.github.io/Desk-tools/) web terminal.

Browsers can't open raw TCP sockets, so a web page can never talk to an SSH
server directly. This program runs on **your** machine, accepts a WebSocket
from the Desk-tools page, and relays it to a real SSH connection. Your
credentials and traffic never leave your computer.

```
Browser (xterm.js)  --WebSocket-->  local-proxy (localhost:8722)  --SSH-->  your server
```

## Run it (no install)

If you have Node.js 18+:

```bash
npx desk-tools-local-proxy
```

Then open the **SSH Terminal** tool in Desk-tools — it will detect the proxy
automatically and let you connect.

## Run it (binary, no Node required)

Download the binary for your OS from the Releases page and run it:

```bash
# macOS / Linux
chmod +x local-proxy-macos-arm64
./local-proxy-macos-arm64

# Windows
local-proxy-windows-x64.exe
```

## Configuration

| Env var                          | Default | Description                          |
| -------------------------------- | ------- | ------------------------------------ |
| `DESK_TOOLS_LOCAL_PROXY_PORT`      | `8722`  | Local port the proxy listens on.     |

The proxy binds to `127.0.0.1` only and rejects WebSocket upgrades whose
`Origin` is not the Desk-tools site (or `localhost:3000` for development).

## Building standalone binaries

**Option A — Bun (cross-compiles all platforms from one machine):**

```bash
bun install
npm run build:bun     # outputs dist/local-proxy-{macos,linux,windows}-*
```

**Option B — @yao-pkg/pkg (the maintained `pkg` fork):**

```bash
npm install
npm run build:pkg
```

> `ssh2` runs in pure JavaScript by default. Do **not** add the optional
> `cpu-features` native dependency — keeping the proxy 100% JS is what lets
> these packagers produce a single self-contained binary.

## Security notes

- Bound to loopback (`127.0.0.1`) — never exposed to your network.
- Validates the WebSocket `Origin` header so other sites can't drive it.
- Credentials are passed per-session from the browser and are never written to
  disk by the proxy.
