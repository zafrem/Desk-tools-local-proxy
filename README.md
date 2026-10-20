# desk-tools-local-proxy

A tiny **local** WebSocket-to-SSH bridge for the [Desk-tools](https://zafrem.github.io/Desk-tools/) web terminal.

Browsers can't open raw TCP sockets, so a web page can never talk to an SSH
server directly. This program runs on **your** machine, accepts a WebSocket
from the Desk-tools page, and relays it to a real SSH connection. Your
credentials and traffic never leave your computer.

```
Browser (xterm.js)  --WebSocket-->  local-proxy (localhost:8722)  --SSH-->  your server
```

## Install and run

This package is not published to npm and no prebuilt binaries are provided.
Clone it and run it from source (Node.js 18+ and git required):

```bash
git clone https://github.com/zafrem/Desk-tools-local-proxy.git
cd Desk-tools-local-proxy
npm install
npm start
```

Then open any console under **Consoles** in Desk-tools — it detects the proxy
automatically. Use **Settings → Proxy → Test connection** to verify the link.

## Configuration

| Env var                          | Default | Description                          |
| -------------------------------- | ------- | ------------------------------------ |
| `DESK_TOOLS_LOCAL_PROXY_PORT`      | `8722`  | Local port the proxy listens on.     |

The proxy binds to `127.0.0.1` only and rejects WebSocket upgrades whose
`Origin` is not the Desk-tools site (or `localhost:3000` for development).

## Standalone binaries (optional, not needed to run)

The proxy runs directly with `npm start`. If you want a single executable you can
build one yourself with a tool of your choice, e.g. `npx @yao-pkg/pkg index.js`
(needs a recent Node.js and OS). It is deliberately not a dependency, so
`npm install` stays light.

## Security notes

- Bound to loopback (`127.0.0.1`) — never exposed to your network.
- Validates the WebSocket `Origin` header so other sites can't drive it.
- Credentials are passed per-session from the browser and are never written to
  disk by the proxy.
