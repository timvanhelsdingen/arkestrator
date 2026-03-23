<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/rest";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";

  interface PathMappingEntry { platform: string; path: string; }
  interface PathMapping { label: string; entries: PathMappingEntry[]; }
  interface ProjectFolder { path: string; description?: string; }
  interface ProjectFile { path: string; description?: string; }
  interface GitHubRepo { url: string; branch?: string; description?: string; }

  interface Project {
    id: string;
    name: string;
    prompt: string | null;
    pathMappings: PathMapping[];
    folders: ProjectFolder[];
    files: ProjectFile[];
    githubRepos: GitHubRepo[];
    createdAt: string;
    updatedAt: string;
  }

  // Prompt presets
  const PROMPT_PRESETS: { label: string; prompt: string }[] = [
    {
      label: "Folder per bridge",
      prompt: "Create a separate subfolder for each bridge program (Blender, Godot, Houdini, etc.) under the project root. Place all generated assets and files for that program inside its respective folder.",
    },
    {
      label: "Organized by asset type",
      prompt: "Organize project files by asset type: models/, textures/, scripts/, scenes/, audio/, and exports/. Each bridge should output to the appropriate asset type folder.",
    },
    {
      label: "Pipeline stages",
      prompt: "Organize files by pipeline stage: 01_concept/, 02_modeling/, 03_texturing/, 04_rigging/, 05_animation/, 06_lighting/, 07_rendering/, 08_compositing/. Each stage maps to the appropriate bridge program.",
    },
    {
      label: "Version controlled",
      prompt: "Use a versioned folder structure: keep a _latest/ folder with the most recent outputs and a _versions/ folder with timestamped snapshots. Agents should always output to _latest/ and archive previous versions before overwriting.",
    },
  ];

  let projects = $state<Project[]>([]);
  let error = $state("");
  let showForm = $state(false);
  let editingId = $state<string | null>(null);

  // New project creation flow
  let rootFolder = $state("");
  let subfolder = $state("");

  let form = $state({
    name: "",
    prompt: "",
    pathMappings: [] as PathMapping[],
    folders: [] as ProjectFolder[],
    files: [] as ProjectFile[],
    githubRepos: [] as GitHubRepo[],
  });

  // Collapsible section state
  let expandedSections = $state({
    pathMappings: false,
    folders: false,
    files: false,
    githubRepos: false,
  });

  /** Sanitize a string for use as a cross-platform folder name */
  function sanitizeFolderName(input: string): string {
    return input
      .toLowerCase()
      .replace(/\s+/g, "-")           // spaces → hyphens
      .replace(/[<>:"\/\\|?*]/g, "")  // remove illegal chars
      .replace(/\.+$/g, "")           // no trailing dots
      .replace(/-{2,}/g, "-")         // collapse multiple hyphens
      .replace(/^-|-$/g, "");         // no leading/trailing hyphens
  }

  /** Derive the project folder name from root + optional subfolder */
  function projectPath(): string {
    if (!rootFolder) return "";
    const sep = rootFolder.includes("\\") ? "\\" : "/";
    if (subfolder.trim()) {
      return rootFolder + sep + sanitizeFolderName(subfolder);
    }
    return rootFolder;
  }

  /** Derive a display name from the effective path */
  function deriveProjectName(): string {
    const path = projectPath();
    if (!path) return "";
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || "Untitled";
  }

  function resetForm() {
    form = {
      name: "",
      prompt: "",
      pathMappings: [],
      folders: [],
      files: [],
      githubRepos: [],
    };
    expandedSections = { pathMappings: false, folders: false, files: false, githubRepos: false };
    editingId = null;
    rootFolder = "";
    subfolder = "";
  }

  async function load() {
    try {
      error = "";
      projects = await api.projects.list();
    } catch (err: any) {
      if (err.message?.includes("403")) {
        error = "Admin access required to manage projects.";
      } else {
        error = err.message;
      }
    }
  }

  /** Start new project — opens folder picker, then shows form */
  async function startNew() {
    try {
      const folder = await openDialog({
        directory: true,
        title: "Select project root folder",
      });
      if (!folder) return;

      resetForm();
      rootFolder = folder as string;
      // Pre-fill name from folder
      const parts = rootFolder.replace(/\\/g, "/").split("/").filter(Boolean);
      form.name = parts[parts.length - 1] || "Untitled";
      form.folders = [{ path: rootFolder, description: "Project root" }];
      showForm = true;
    } catch {
      // User cancelled
    }
  }

  function startEdit(project: Project) {
    // Toggle: if already editing this project, close the form
    if (editingId === project.id && showForm) {
      showForm = false;
      editingId = null;
      return;
    }
    // Use JSON round-trip instead of structuredClone — Svelte 5 $state proxies can't be structuredCloned
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    editingId = project.id;
    rootFolder = "";
    subfolder = "";
    form = {
      name: project.name,
      prompt: project.prompt ?? "",
      pathMappings: clone(project.pathMappings ?? []),
      folders: clone(project.folders ?? []),
      files: clone(project.files ?? []),
      githubRepos: clone(project.githubRepos ?? []),
    };
    if (form.folders.length > 0) {
      rootFolder = form.folders[0].path;
    }
    expandedSections = {
      pathMappings: (project.pathMappings?.length ?? 0) > 0,
      folders: (project.folders?.length ?? 0) > 0,
      files: (project.files?.length ?? 0) > 0,
      githubRepos: (project.githubRepos?.length ?? 0) > 0,
    };
    showForm = true;
  }

  async function save() {
    // If subfolder was specified, update the project path and name
    if (!editingId && rootFolder && subfolder.trim()) {
      const sanitized = sanitizeFolderName(subfolder);
      if (sanitized) {
        const sep = rootFolder.includes("\\") ? "\\" : "/";
        const fullPath = rootFolder + sep + sanitized;
        form.name = sanitized;
        // Update or set the first folder entry
        if (form.folders.length > 0) {
          form.folders[0] = { path: fullPath, description: "Project root" };
        } else {
          form.folders = [{ path: fullPath, description: "Project root" }];
        }
        // Create the folder on disk via Tauri
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("fs_create_directory", { path: fullPath, recursive: true });
        } catch {
          // Best effort — folder may already exist or invoke may not be available
        }
      }
    }

    const cleanMappings = form.pathMappings
      .map(m => ({
        ...m,
        entries: m.entries.filter(e => e.path.trim()),
      }))
      .filter(m => m.label.trim() || m.entries.length > 0);

    const cleanFolders = form.folders.filter(f => f.path.trim());
    const cleanFiles = form.files.filter(f => f.path.trim());
    const cleanRepos = form.githubRepos.filter(r => r.url.trim());

    const data = {
      name: form.name,
      prompt: form.prompt || undefined,
      pathMappings: cleanMappings,
      folders: cleanFolders,
      files: cleanFiles,
      githubRepos: cleanRepos,
    };
    try {
      if (editingId) {
        await api.projects.update(editingId, data);
      } else {
        await api.projects.create(data);
      }
      showForm = false;
      resetForm();
      await load();
    } catch (err: any) {
      error = err.message;
    }
  }

  async function deleteProject(e: MouseEvent, id: string, name: string) {
    e.stopPropagation();
    if (!confirm(`Delete project "${name}"?`)) return;
    try {
      await api.projects.delete(id);
      if (editingId === id) {
        showForm = false;
        resetForm();
      }
      await load();
    } catch (err: any) {
      error = err.message;
    }
  }

  function applyPreset(preset: { label: string; prompt: string }) {
    if (form.prompt && !form.prompt.endsWith("\n")) {
      form.prompt += "\n\n";
    }
    form.prompt += preset.prompt;
  }

  // Multiparm helpers
  function addPathMapping() {
    form.pathMappings = [...form.pathMappings, { label: "", entries: [{ platform: "Windows", path: "" }, { platform: "Linux", path: "" }] }];
    expandedSections.pathMappings = true;
  }

  function removePathMapping(i: number) {
    form.pathMappings = form.pathMappings.filter((_, j) => j !== i);
  }

  function addMappingEntry(mappingIndex: number) {
    form.pathMappings[mappingIndex].entries = [...form.pathMappings[mappingIndex].entries, { platform: "", path: "" }];
  }

  function removeMappingEntry(mappingIndex: number, entryIndex: number) {
    form.pathMappings[mappingIndex].entries = form.pathMappings[mappingIndex].entries.filter((_, j) => j !== entryIndex);
  }

  function addFolder() {
    form.folders = [...form.folders, { path: "", description: "" }];
    expandedSections.folders = true;
  }

  function addFile() {
    form.files = [...form.files, { path: "", description: "" }];
    expandedSections.files = true;
  }

  function addGitHubRepo() {
    form.githubRepos = [...form.githubRepos, { url: "", branch: "", description: "" }];
    expandedSections.githubRepos = true;
  }

  function summarizeProject(project: Project): string {
    const parts: string[] = [];
    if (project.pathMappings?.length) parts.push(`${project.pathMappings.length} path mapping${project.pathMappings.length > 1 ? "s" : ""}`);
    if (project.folders?.length) parts.push(`${project.folders.length} folder${project.folders.length > 1 ? "s" : ""}`);
    if (project.files?.length) parts.push(`${project.files.length} file${project.files.length > 1 ? "s" : ""}`);
    if (project.githubRepos?.length) parts.push(`${project.githubRepos.length} repo${project.githubRepos.length > 1 ? "s" : ""}`);
    return parts.length ? parts.join(", ") : "";
  }

  function shortId(id: string): string {
    return id.split("-")[0] || id.slice(0, 8);
  }

  onMount(load);
</script>

<div class="projects-page">
  <div class="list-panel">
    <div class="toolbar">
      <h2>Projects</h2>
      <span class="project-count">{projects.length}</span>
    </div>

    {#if error}
      <div class="error-banner">{error}</div>
    {/if}

    <div class="project-grid">
      <!-- New Project card (opens folder picker) -->
      <button class="project-card new-card" onclick={startNew}>
        <span class="new-icon">+</span>
        <span class="new-label">New Project</span>
      </button>

      {#each projects as project (project.id)}
        <div class="project-card" class:selected={editingId === project.id}>
          <div class="card-top">
            <strong class="card-name">{project.name}</strong>
          </div>
          <span class="card-id">{shortId(project.id)}</span>
          {#if project.prompt}
            <div class="card-prompt">{project.prompt.length > 80 ? project.prompt.slice(0, 80) + "..." : project.prompt}</div>
          {/if}
          {#if summarizeProject(project)}
            <div class="card-summary">{summarizeProject(project)}</div>
          {/if}
          <div class="card-actions">
            <button type="button" class="card-action-btn" onclick={() => startEdit(project)}>Edit</button>
            <button type="button" class="card-action-btn danger" onclick={(e) => deleteProject(e, project.id, project.name)}>Delete</button>
          </div>
        </div>
      {/each}

      {#if projects.length === 0 && !error}
        <div class="empty-hint">
          <p>Projects define context that gets injected into agent system prompts.</p>
        </div>
      {/if}
    </div>
  </div>

  {#if showForm}
    <div class="form-panel">
      <div class="form-header">
        <h3>{editingId ? "Edit Project" : "New Project"}</h3>
        <button class="btn-close" onclick={() => { showForm = false; resetForm(); }}>&times;</button>
      </div>
      <form onsubmit={(e) => { e.preventDefault(); save(); }}>
        {#if rootFolder && !editingId}
          <div class="folder-path-row">
            <span class="folder-path-base">{rootFolder.replace(/\\/g, "/")}</span>
            <span class="folder-path-sep">/</span>
            <input
              class="folder-path-sub"
              bind:value={subfolder}
              placeholder={form.name || "subfolder"}
              oninput={() => {
                if (subfolder.trim()) {
                  form.name = sanitizeFolderName(subfolder);
                }
              }}
            />
          </div>
          <span class="field-hint" style="margin-bottom: 10px; display: block;">
            Type a subfolder name to create a new directory, or leave empty to use the selected folder as-is. Names are auto-sanitized for cross-platform compatibility.
          </span>
        {/if}

        <label class="field">
          Name
          <input bind:value={form.name} required placeholder="My Project" />
        </label>

        <label class="field">
          Project Prompt
          <div class="preset-bar">
            <span class="preset-label">Presets:</span>
            {#each PROMPT_PRESETS as preset}
              <button type="button" class="preset-chip" onclick={() => applyPreset(preset)} title={preset.prompt}>
                {preset.label}
              </button>
            {/each}
          </div>
          <textarea bind:value={form.prompt} rows="8" placeholder="Per-project instructions for the AI agent (e.g., coding conventions, file structure, tool preferences, important context)"></textarea>
          <span class="field-hint">Injected into every agent's system prompt when this project is selected</span>
        </label>

        <!-- Path Mappings -->
        <div class="section">
          <button type="button" class="section-header" onclick={() => expandedSections.pathMappings = !expandedSections.pathMappings}>
            <span class="section-chevron" class:expanded={expandedSections.pathMappings}>&#9654;</span>
            Path Mappings
            {#if form.pathMappings.length > 0}
              <span class="section-count">{form.pathMappings.length}</span>
            {/if}
          </button>
          {#if expandedSections.pathMappings}
            <div class="section-body">
              <span class="field-hint">Cross-platform path equivalences (e.g., W:/ on Windows = /mnt/work on Linux)</span>
              {#each form.pathMappings as mapping, i}
                <div class="multiparm-group">
                  <div class="multiparm-group-header">
                    <input bind:value={mapping.label} placeholder="Label (e.g., Project Root)" class="input-sm" />
                    <button type="button" class="btn-remove" onclick={() => removePathMapping(i)} title="Remove mapping">&times;</button>
                  </div>
                  {#each mapping.entries as entry, j}
                    <div class="multiparm-row">
                      <input bind:value={entry.platform} placeholder="Platform" class="input-platform" />
                      <input bind:value={entry.path} placeholder="/path/on/this/platform" class="input-path" />
                      <button type="button" class="btn-remove-sm" onclick={() => removeMappingEntry(i, j)} title="Remove entry">&times;</button>
                    </div>
                  {/each}
                  <button type="button" class="btn-add-sm" onclick={() => addMappingEntry(i)}>+ Platform</button>
                </div>
              {/each}
              <button type="button" class="btn-add" onclick={addPathMapping}>+ Add Path Mapping</button>
            </div>
          {/if}
        </div>

        <!-- Folders -->
        <div class="section">
          <button type="button" class="section-header" onclick={() => expandedSections.folders = !expandedSections.folders}>
            <span class="section-chevron" class:expanded={expandedSections.folders}>&#9654;</span>
            Folders
            {#if form.folders.length > 0}
              <span class="section-count">{form.folders.length}</span>
            {/if}
          </button>
          {#if expandedSections.folders}
            <div class="section-body">
              <span class="field-hint">Relevant project folders the agent should know about</span>
              {#each form.folders as folder, i}
                <div class="multiparm-row">
                  <input bind:value={folder.path} placeholder="/path/to/folder" class="input-path" />
                  <input bind:value={folder.description} placeholder="Description (optional)" class="input-desc" />
                  <button type="button" class="btn-remove-sm" onclick={() => { form.folders = form.folders.filter((_, j) => j !== i); }} title="Remove">&times;</button>
                </div>
              {/each}
              <button type="button" class="btn-add" onclick={addFolder}>+ Add Folder</button>
            </div>
          {/if}
        </div>

        <!-- Files -->
        <div class="section">
          <button type="button" class="section-header" onclick={() => expandedSections.files = !expandedSections.files}>
            <span class="section-chevron" class:expanded={expandedSections.files}>&#9654;</span>
            Files
            {#if form.files.length > 0}
              <span class="section-count">{form.files.length}</span>
            {/if}
          </button>
          {#if expandedSections.files}
            <div class="section-body">
              <span class="field-hint">Specific files the agent should be aware of</span>
              {#each form.files as file, i}
                <div class="multiparm-row">
                  <input bind:value={file.path} placeholder="/path/to/file" class="input-path" />
                  <input bind:value={file.description} placeholder="Description (optional)" class="input-desc" />
                  <button type="button" class="btn-remove-sm" onclick={() => { form.files = form.files.filter((_, j) => j !== i); }} title="Remove">&times;</button>
                </div>
              {/each}
              <button type="button" class="btn-add" onclick={addFile}>+ Add File</button>
            </div>
          {/if}
        </div>

        <!-- GitHub Repos -->
        <div class="section">
          <button type="button" class="section-header" onclick={() => expandedSections.githubRepos = !expandedSections.githubRepos}>
            <span class="section-chevron" class:expanded={expandedSections.githubRepos}>&#9654;</span>
            GitHub Repositories
            {#if form.githubRepos.length > 0}
              <span class="section-count">{form.githubRepos.length}</span>
            {/if}
          </button>
          {#if expandedSections.githubRepos}
            <div class="section-body">
              <span class="field-hint">Linked repositories for project context</span>
              {#each form.githubRepos as repo, i}
                <div class="multiparm-group">
                  <div class="multiparm-row">
                    <input bind:value={repo.url} placeholder="https://github.com/org/repo" class="input-path" />
                    <input bind:value={repo.branch} placeholder="Branch (optional)" class="input-branch" />
                    <button type="button" class="btn-remove-sm" onclick={() => { form.githubRepos = form.githubRepos.filter((_, j) => j !== i); }} title="Remove">&times;</button>
                  </div>
                  <input bind:value={repo.description} placeholder="Description (optional)" class="input-full" />
                </div>
              {/each}
              <button type="button" class="btn-add" onclick={addGitHubRepo}>+ Add Repository</button>
            </div>
          {/if}
        </div>

        <div class="form-actions">
          <button type="submit" class="btn-primary">{editingId ? "Update" : "Create"}</button>
          <button type="button" class="btn-secondary" onclick={() => { showForm = false; resetForm(); }}>Cancel</button>
        </div>
      </form>
    </div>
  {/if}
</div>

<style>
  .projects-page { display: flex; height: 100%; overflow: hidden; }
  .list-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h2 { font-size: var(--font-size-lg); }
  .project-count {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--bg-elevated);
    color: var(--text-muted);
  }

  /* Grid layout */
  .project-grid {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
    align-content: start;
  }

  /* Project cards */
  .project-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 80px;
    transition: border-color 0.15s;
  }
  .project-card:hover {
    border-color: var(--accent);
  }
  .project-card.selected {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 8%, var(--bg-surface));
  }

  /* New project card */
  .new-card {
    border: 2px dashed var(--accent);
    background: transparent;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    gap: 4px;
  }
  .new-card:hover {
    background: color-mix(in oklab, var(--accent) 8%, transparent);
  }
  .new-icon {
    font-size: 28px;
    font-weight: 300;
    line-height: 1;
  }
  .new-label {
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  /* Folder path row in form */
  .folder-path-row {
    display: flex;
    align-items: center;
    gap: 0;
    margin-bottom: 6px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    overflow: hidden;
  }
  .folder-path-base {
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 1;
    min-width: 0;
  }
  .folder-path-sep {
    color: var(--text-muted);
    flex-shrink: 0;
    margin: 0 2px;
  }
  .folder-path-sub {
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    flex: 1;
    min-width: 80px;
    padding: 0;
  }
  .folder-path-sub::placeholder {
    color: var(--text-muted);
    opacity: 0.5;
  }

  /* Card content */
  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 6px;
  }
  .card-name {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    word-break: break-word;
  }
  .card-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .card-action-btn {
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
  }
  .card-action-btn:hover { color: var(--accent); }
  .card-action-btn.danger:hover { color: var(--status-failed); }
  .card-id {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    opacity: 0.7;
  }
  .card-prompt {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.4;
    word-break: break-word;
  }
  .card-summary {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: auto;
  }

  .empty-hint {
    grid-column: 1 / -1;
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .error-banner {
    padding: 8px 16px;
    background: rgba(244, 71, 71, 0.15);
    color: var(--status-failed);
    font-size: var(--font-size-sm);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .btn-primary {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary {
    padding: 6px 16px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
  }

  /* Form panel */
  .form-panel {
    width: 480px;
    border-left: 1px solid var(--border);
    padding: 16px;
    overflow-y: auto;
    flex-shrink: 0;
  }
  .form-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .form-header h3 { font-size: var(--font-size-lg); }
  .btn-close {
    font-size: 20px;
    color: var(--text-muted);
    padding: 0 4px;
  }
  .btn-close:hover { color: var(--text-primary); }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 12px;
  }
  .field textarea {
    resize: both;
    max-width: 100%;
    min-height: 120px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }
  .field-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .form-actions { display: flex; gap: 8px; margin-top: 16px; }

  /* Preset bar */
  .preset-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .preset-label {
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .preset-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.15s, color 0.15s;
  }
  .preset-chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* Collapsible sections */
  .section {
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    background: var(--bg-elevated);
    text-align: left;
    cursor: pointer;
  }
  .section-header:hover { background: var(--bg-active); }
  .section-chevron {
    font-size: 10px;
    transition: transform 0.15s ease;
    color: var(--text-muted);
  }
  .section-chevron.expanded { transform: rotate(90deg); }
  .section-count {
    background: var(--accent);
    color: white;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 500;
  }
  .section-body {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Multiparm rows */
  .multiparm-group {
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .multiparm-group-header {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .multiparm-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .input-sm {
    flex: 1;
    font-size: var(--font-size-sm);
    padding: 4px 8px;
  }
  .input-platform {
    width: 80px;
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    padding: 4px 8px;
  }
  .input-path {
    flex: 1;
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    padding: 4px 8px;
  }
  .input-desc {
    flex: 1;
    font-size: var(--font-size-sm);
    padding: 4px 8px;
  }
  .input-branch {
    width: 100px;
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    padding: 4px 8px;
  }
  .input-full {
    width: 100%;
    font-size: var(--font-size-sm);
    padding: 4px 8px;
  }
  .btn-remove {
    font-size: 18px;
    color: var(--text-muted);
    padding: 0 4px;
    flex-shrink: 0;
  }
  .btn-remove:hover { color: var(--status-failed); }
  .btn-remove-sm {
    font-size: 16px;
    color: var(--text-muted);
    padding: 0 2px;
    flex-shrink: 0;
  }
  .btn-remove-sm:hover { color: var(--status-failed); }
  .btn-add, .btn-add-sm {
    font-size: var(--font-size-sm);
    color: var(--accent);
    text-align: left;
    padding: 2px 0;
  }
  .btn-add:hover, .btn-add-sm:hover { text-decoration: underline; }
  .btn-add-sm { font-size: 11px; }
</style>
