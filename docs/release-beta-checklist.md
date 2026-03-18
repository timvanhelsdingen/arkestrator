# Release/Beta Checklist

## Build and Test

- [x] `pnpm --filter @arkestrator/protocol build`
- [x] `pnpm --filter @arkestrator/server test`
- [x] `pnpm --filter @arkestrator/admin build`
- [x] `pnpm --filter @arkestrator/client build`
- [x] Smoke test: start server, authenticate, submit paused job, list jobs (isolated temp DB on alternate port)

## Security and Hygiene

- [ ] No committed local DBs, temp prompt artifacts, or `.mcp.json` runtime files
- [ ] No hardcoded secrets/tokens in tracked files
- [ ] Bootstrap admin password flow verified

## Runtime Naming

- [ ] Shared config path verified (`~/.arkestrator/config.json`)
- [ ] Runtime env vars verified (`ARKESTRATOR_*`)
- [ ] Sidecar binary naming verified (`arkestrator-server-*`)

## Documentation

- [ ] README current
- [ ] Installation and configuration docs current
- [ ] Reports updated for release tag

## Rollout Order

1. Finalize Arkestrator naming and release baselines
2. Validate builds/tests/docs
3. Rename GitHub repo
4. Push release commit and confirm `Publish Server Image` succeeds
5. Redeploy TrueNAS app (`arkestrator`) and verify `/health` returns `{"status":"ok"}`
6. Optionally rename GitHub org after integration checks

## TrueNAS Redeploy Command

```powershell
$env:GH_TOKEN = "<github-token-with-actions-read>"
powershell -ExecutionPolicy Bypass -File .\scripts\wait-ghcr-and-redeploy-truenas.ps1 -Repo "<owner>/<repo>" -TrueNasHost "truenas.local" -AppName "arkestrator"
# PowerShell 7+: pwsh ./scripts/wait-ghcr-and-redeploy-truenas.ps1 -Repo "<owner>/<repo>" -TrueNasHost "truenas.local" -AppName "arkestrator"
```
