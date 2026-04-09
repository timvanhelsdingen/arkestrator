---
name: file-transfer-protocol
description: How to transfer files between server and clients using direct serve, P2P, or upload modes
metadata:
  category: coordinator
  title: File Transfer Protocol
  keywords:
    - file
    - transfer
    - upload
    - download
    - deliver
    - send
    - copy
    - move
    - p2p
    - direct
    - stream
  priority: 60
  auto-fetch: true
---

# File Transfer Protocol

Transfer files between the server, connected clients, and workers using Arkestrator's transfer system.

## Three Transfer Modes

All modes use `POST /api/transfers` via `client_api_request`. The mode is determined by which fields you provide.

### Mode 1: Direct Serve (server filesystem -> client)

Use when the file already exists on the **server's filesystem** (e.g. NAS mount, local disk). No upload step, no size limit, no temp copy.

```json
{
  "files": [{"path": "/dest/path/on/client/file.vdb"}],
  "sourcePaths": ["/mnt/truenas/path/to/file.vdb"],
  "target": "worker-name",
  "targetType": "worker"
}
```

The server streams the file directly from disk to the client. File size is computed automatically.

### Mode 2: P2P (client -> client)

Use when the source file is on a **connected client/worker** and the destination is another client. The server only coordinates -- file data flows directly between clients.

```json
{
  "files": [{"path": "/dest/path/file.vdb", "size": 2929823546}],
  "sourcePaths": ["/source/path/on/source/machine/file.vdb"],
  "sourceWorker": "source-worker-name",
  "target": "dest-worker-name",
  "targetType": "worker"
}
```

Flow: server asks source client to start a file server -> source reports ready -> server tells destination the P2P URL -> destination downloads directly from source. Falls back to server relay automatically if P2P connection fails.

### Mode 3: Upload (classic relay)

Use when neither direct serve nor P2P applies. Client uploads to server temp, server delivers to target.

```json
{
  "files": [{"path": "/dest/path/file.ext", "size": 1048576}],
  "target": "worker-name",
  "targetType": "worker"
}
```

Returns `uploadUrl` per file. Upload via PUT with raw bytes. Server delivers automatically when all files are uploaded. Subject to `transferMaxSizeMb` limit (default 2000 MB).

## How to Choose the Mode

1. **File is on the server filesystem?** -> Use direct serve (`sourcePaths`, no `sourceWorker`)
2. **File is on another connected client?** -> Use P2P (`sourcePaths` + `sourceWorker`)
3. **You have the file data in memory/base64?** -> Use upload mode (no `sourcePaths`)
4. **File is small (< 1 MB)?** -> Use `POST /api/bridge-command/file-deliver` for inline delivery

## Finding Workers

List connected workers: `GET /api/workers`

Each worker has a `name` (hostname) and `status`. Use the name as the `target` or `sourceWorker` value with `targetType: "worker"`.

## Target Types

- `"worker"` -- target by worker name (hostname)
- `"program"` -- target all bridges running a program (blender, godot, houdini)
- `"id"` -- target a specific bridge by connection ID

## Destination Paths

- macOS: use forward slashes, e.g. `/Users/username/Documents/file.vdb`
- iCloud Drive on macOS: `~/Library/Mobile Documents/com~apple~CloudDocs/Documents/`
- Windows: use backslashes, e.g. `C:\\Users\\username\\Documents\\file.vdb`
- Linux: forward slashes, e.g. `/home/username/Documents/file.vdb`

## Important Notes

- `deliverFiles` permission required on the API key
- Direct serve may require `DIRECT_SERVE_ALLOWED_PATHS` to be configured on the server
- P2P transfers use ephemeral token-based auth (no API key exposure)
- All modes support resume via Range headers for large files
- Use `client_api_request` tool to call the transfer endpoints from within a job
