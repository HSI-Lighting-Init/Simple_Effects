# Simple Effects — MCP server (Claude Desktop / VS Code)

Let an external agent (Claude Desktop, the Claude VS Code extension, Cursor, …)
drive Simple Effects: arrange clips, trim, transition, add text, basic colour,
music, and check preview frames — the same tools the in-app "Scenario → Video"
agent uses.

## How it fits together

```
Claude Desktop / VS Code   ──stdio──▶   simple-effects-mcp.mjs   ──HTTP──▶   Simple Effects (running)
        (MCP client)                       (this proxy)                     localhost bridge → engine + renderer
```

The proxy holds **no** editing logic. Simple Effects must be **open** and its
localhost bridge enabled; the proxy forwards `tools/list` and `tools/call` to it,
so the tools operate on your live timeline and you watch the edits happen.

> Because compositing only happens in the running app, there is no headless mode:
> the app has to be open for tools (especially `render_preview`) to work.

## Install

```
cd mcp
npm install
```

## Enable the bridge in the app

In Simple Effects: **Templates → AI: Enable MCP bridge** (starts a localhost
listener on `127.0.0.1:8787`). Leave the app running while an external agent works.

## Configure the client

**Claude Desktop** — `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "simple-effects": {
      "command": "node",
      "args": ["C:/Workspace/Simple_Effects/Simple_Effects/mcp/simple-effects-mcp.mjs"],
      "env": { "SIMPLE_EFFECTS_MCP_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

**VS Code** (Claude extension / any MCP-capable agent) — in the workspace MCP
config (e.g. `.vscode/mcp.json`):

```json
{
  "servers": {
    "simple-effects": {
      "command": "node",
      "args": ["${workspaceFolder}/mcp/simple-effects-mcp.mjs"]
    }
  }
}
```

Restart the client; "simple-effects" and its tools appear. Ask it to build
something ("open the three photos, cut a 15s intro with a title on each"), and
watch the timeline fill in the app.

## Bridge contract (what the app exposes)

The app's localhost bridge serves the shared tool registry (`src/agent/tools.ts`),
so schemas never drift from the in-app agent:

- `GET  /mcp/tools` → `{ tools: [{ name, description, inputSchema }] }`
- `POST /mcp/call` `{ name, arguments }` →
  `{ content: [ {type:"text",text} | {type:"image",data,mimeType} ], isError? }`

## Scope

Same as the in-app agent: arrange / trim / split / transition / speed / text /
basic colour / audio (volume, fade). No LUT, chroma key, stabilize, denoise, or
ducking — those don't exist in the engine yet. Export stays a one-click action
in the app after the agent finishes.

## Status

The proxy, protocol, and config here are ready. The **app-side localhost bridge**
(the Rust listener that forwards `/mcp/*` to the frontend tool registry) is the
one remaining wire — tracked as the next build. Until it ships, the in-app
"Scenario → Video" panel is the working path.
