<script lang="ts">
  import { api } from "../../api/rest";

  interface McpConfig {
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    url?: string;
  }

  interface McpBridge {
    id: string;
    name: string;
    displayName: string;
    mcpConfig?: McpConfig;
    enabled: boolean;
  }

  interface McpState {
    name: string;
    displayName: string;
    transport: "stdio" | "sse";
    command: string;
    args: string;
    url: string;
    saving: boolean;
    saved: boolean;
    error: string;
  }

  let existing = $state<McpBridge[]>([]);
  let showForm = $state(false);
  let loading = $state(true);
  let loadError = $state("");

  let form = $state<McpState>({
    name: "",
    displayName: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    saving: false,
    saved: false,
    error: "",
  });

  async function loadExisting() {
    try {
      const bridges = (await api.apiBridges.list()) as McpBridge[];
      existing = bridges.filter((b) => b.mcpConfig);
    } catch {
      // Not authenticated yet in wizard flow
    } finally {
      loading = false;
    }
  }

  loadExisting();

  function resetForm() {
    form = {
      name: "",
      displayName: "",
      transport: "stdio",
      command: "",
      args: "",
      url: "",
      saving: false,
      saved: false,
      error: "",
    };
  }

  async function saveServer() {
    if (!form.name || (!form.command && form.transport === "stdio") || (!form.url && form.transport === "sse")) {
      form.error = "Fill in all required fields";
      return;
    }
    form.saving = true;
    form.error = "";
    try {
      const mcpConfig: Record<string, unknown> = { transport: form.transport };
      if (form.transport === "stdio") {
        mcpConfig.command = form.command;
        const args = form.args.split("\n").map((a) => a.trim()).filter(Boolean);
        if (args.length) mcpConfig.args = args;
      } else {
        mcpConfig.url = form.url;
      }
      await api.apiBridges.create({
        name: form.name,
        displayName: form.displayName || form.name,
        type: "custom",
        authType: "none",
        mcpConfig,
        enabled: true,
      });
      form.saved = true;
      showForm = false;
      await loadExisting();
      resetForm();
    } catch (err: any) {
      form.error = err.message ?? String(err);
    } finally {
      form.saving = false;
    }
  }
</script>

<h2>MCP Servers</h2>
<p class="subtitle">
  Connect Model Context Protocol (MCP) servers to extend agent capabilities with external tools.
  MCP servers expose actions like file access, database queries, or custom workflows that agents can invoke during tasks.
</p>
<p class="hint">You can always add or change MCP servers later in Settings.</p>

{#if loading}
  <div class="loading">Loading...</div>
{:else}
  {#if existing.length > 0}
    <div class="server-list">
      {#each existing as server}
        <div class="server-card saved">
          <span class="server-name">{server.displayName}</span>
          <span class="server-detail">
            {#if server.mcpConfig?.transport === "stdio"}
              {server.mcpConfig.command} {(server.mcpConfig.args ?? []).join(" ")}
            {:else}
              {server.mcpConfig?.url ?? ""}
            {/if}
          </span>
          <span class="badge saved">Configured</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if showForm}
    <div class="form-card">
      <label class="field">
        <span>Name (slug)</span>
        <input bind:value={form.name} placeholder="my-mcp-server" />
      </label>
      <label class="field">
        <span>Display Name</span>
        <input bind:value={form.displayName} placeholder="My MCP Server" />
      </label>
      <label class="field">
        <span>Transport</span>
        <select bind:value={form.transport}>
          <option value="stdio">Command (stdio)</option>
          <option value="sse">URL (SSE/HTTP)</option>
        </select>
      </label>
      {#if form.transport === "stdio"}
        <label class="field">
          <span>Command</span>
          <input bind:value={form.command} placeholder="npx" />
          <span class="field-hint">e.g. npx, uvx, node, python</span>
        </label>
        <label class="field">
          <span>Arguments (one per line)</span>
          <textarea bind:value={form.args} rows="3" placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/tmp"}></textarea>
        </label>
      {:else}
        <label class="field">
          <span>Server URL</span>
          <input bind:value={form.url} placeholder="http://localhost:3001/sse" />
        </label>
      {/if}
      {#if form.error}
        <div class="field-error">{form.error}</div>
      {/if}
      <div class="form-actions">
        <button class="btn-add" onclick={saveServer} disabled={form.saving}>
          {form.saving ? "Adding..." : "Add Server"}
        </button>
        <button class="btn-cancel" onclick={() => { showForm = false; resetForm(); }}>Cancel</button>
      </div>
    </div>
  {:else}
    <button class="btn-add-server" onclick={() => (showForm = true)}>
      + Add MCP Server
    </button>
  {/if}

  {#if !showForm && existing.length === 0}
    <p class="hint">No MCP servers configured yet. Click above to add one, or skip this step and configure later in Settings.</p>
  {/if}

  {#if loadError}
    <div class="error">{loadError}</div>
  {/if}
{/if}

<style>
  h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0 0 8px;
    line-height: 1.5;
  }
  .hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 16px;
    font-style: italic;
  }
  .loading {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
    padding: 20px;
  }
  .error {
    font-size: 12px;
    color: var(--status-failed);
    margin-top: 8px;
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }
  .server-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    background: var(--bg-surface);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .server-card.saved {
    border-color: var(--status-completed);
    background: color-mix(in srgb, var(--status-completed) 5%, var(--bg-surface));
  }
  .server-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .server-detail {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge.saved {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(78, 201, 176, 0.15);
    color: var(--status-completed);
    font-weight: 600;
    margin-left: auto;
  }

  .form-card {
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 12px;
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .field input, .field select, .field textarea {
    padding: 5px 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .field textarea {
    font-family: var(--font-mono);
    resize: vertical;
  }
  .field-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .field-error {
    font-size: 11px;
    color: var(--status-failed);
  }
  .form-actions {
    display: flex;
    gap: 8px;
  }

  .btn-add-server {
    width: 100%;
    padding: 10px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .btn-add-server:hover {
    border-color: var(--accent);
    color: var(--text-primary);
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }

  .btn-add {
    padding: 6px 16px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .btn-add:hover { filter: brightness(1.08); }
  .btn-add:disabled { opacity: 0.5; cursor: default; }
  .btn-cancel {
    padding: 6px 16px;
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .btn-cancel:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
</style>
