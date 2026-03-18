import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "./stores/toast.svelte";

let hasCheckedForUpdate = false;

export async function checkForAppUpdatesOnce() {
  if (hasCheckedForUpdate || import.meta.env.DEV) {
    return;
  }
  hasCheckedForUpdate = true;

  try {
    const update = await check();
    if (!update) {
      return;
    }

    toast.info(`Update ${update.version} available. Downloading...`);
    await update.downloadAndInstall();
    const shouldRestart = window.confirm(
      `Update ${update.version} installed.\n\nRestart Arkestrator now to apply it?`,
    );
    if (shouldRestart) {
      await invoke("restart_app");
      return;
    }

    toast.success("Update installed. Restart Arkestrator when convenient.");
  } catch (error) {
    // Updater may be intentionally unconfigured in local/private dev environments.
    console.info("[updater] check skipped:", error);
  }
}
