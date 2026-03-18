<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/rest";

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

  let projects = $state<Project[]>([]);
  let error = $state("");
  let showForm = $state(false);
  let editingId = $state<string | null>(null);

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

  function startEdit(project: Project) {
    editingId = project.id;
    form = {
      name: project.name,
      prompt: project.prompt ?? "",
      pathMappings: structuredClone(project.pathMappings ?? []),
      folders: structuredClone(project.folders ?? []),
      files: structuredClone(project.files ?? []),
      githubRepos: structuredClone(project.githubRepos ?? []),
    };
    // Auto-expand sections that have data
    expandedSections = {
      pathMappings: (project.pathMappings?.length ?? 0) > 0,
      folders: (project.folders?.length ?? 0) > 0,
      files: (project.files?.length ?? 0) > 0,
      githubRepos: (project.githubRepos?.length ?? 0) > 0,
    };
    showForm = true;
  }

  async function save() {
    // Filter out empty entries before saving
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

  async function deleteProject(id: string, name: string) {
    if (!confirm(`Delete project "${name}"?`)) return;
    try {
      await api.projects.delete(id);
      await load();
    } catch (err: any) {
      error = err.message;
    }
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

  onMount(load);
</script>

<div class="projects-page">
  <div class="list-panel">
    <div class="toolbar">
      <h2>Projects</h2>
      <button class="btn-primary" onclick={() => { resetForm(); showForm = true; }}>+ New Project</button>
    </div>

    {#if error}
      <div class="error-banner">{error}</div>
    {/if}

    <div class="project-list">
      {#each projects as project (project.id)}
        <div class="project-card">
          <div class="project-header">
            <strong>{project.name}</strong>
          </div>
          <div class="project-details">
            {#if project.prompt}
              <div class="prompt-preview">{project.prompt.length > 120 ? project.prompt.slice(0, 120) + "..." : project.prompt}</div>
            {/if}
            {#if summarizeProject(project)}
              <div class="project-summary">{summarizeProject(project)}</div>
            {/if}
          </div>
          <div class="project-actions">
            <button class="btn-sm" onclick={() => startEdit(project)}>Edit</button>
            <button class="btn-sm danger" onclick={() => deleteProject(project.id, project.name)}>Delete</button>
          </div>
        </div>
      {:else}
        {#if !error}
          <div class="empty">
            <p>No projects configured</p>
            <p class="hint">Projects define context documents that get injected into agent system prompts when selected.</p>
          </div>
        {/if}
      {/each}
    </div>
  </div>

  {#if showForm}
    <div class="form-panel">
      <div class="form-header">
        <h3>{editingId ? "Edit Project" : "New Project"}</h3>
        <button class="btn-close" onclick={() => { showForm = false; resetForm(); }}>&times;</button>
      </div>
      <form onsubmit={(e) => { e.preventDefault(); save(); }}>
        <label class="field">
          Name
          <input bind:value={form.name} required placeholder="My Project" />
        </label>

        <label class="field">
          Project Prompt
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
  .list-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  h2 { font-size: var(--font-size-lg); }
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
  .error-banner {
    padding: 8px 16px;
    background: rgba(244, 71, 71, 0.15);
    color: var(--status-failed);
    font-size: var(--font-size-sm);
    border-bottom: 1px solid var(--border);
  }
  .project-list {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .project-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px;
  }
  .project-header {
    margin-bottom: 8px;
  }
  .project-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .prompt-preview {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .project-summary {
    color: var(--text-muted);
    font-size: 11px;
  }
  .project-actions { display: flex; gap: 6px; }
  .btn-sm {
    padding: 3px 10px;
    font-size: var(--font-size-sm);
    background: var(--bg-elevated);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
  }
  .btn-sm:hover { background: var(--bg-active); }
  .btn-sm.danger:hover { background: var(--status-failed); color: white; }
  .empty {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .hint {
    font-size: var(--font-size-sm);
    margin-top: 8px;
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
