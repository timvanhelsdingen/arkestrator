-- Resolve repo root relative to this .app bundle (located in tools/mac/)
set appPath to POSIX path of (path to me)
set repoRoot to do shell script "cd \"$(dirname " & quoted form of appPath & ")/../..\" && pwd"
set launcherPath to repoRoot & "/scripts/start-comfyui-bridge-mac.sh"

do shell script "cd " & quoted form of repoRoot & " && bash " & quoted form of launcherPath & " open >/dev/null 2>&1 &"
