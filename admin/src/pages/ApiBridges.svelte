<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api/client";
  import { toast } from "../lib/stores/toast.svelte";
  import Modal from "../lib/components/ui/Modal.svelte";

  interface McpConfig {
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }

  interface ApiBridge {
    id: string;
    name: string;
    displayName: string;
    type: "preset" | "custom";
    presetId?: string;
    baseUrl?: string;
    authType: string;
    enabled: boolean;
    hasApiKey: boolean;
    mcpConfig?: McpConfig;
    createdAt: string;
    updatedAt: string;
  }

  interface PresetInfo {
    presetId: string;
    displayName: string;
    defaultBaseUrl: string;
    authType?: string;
    description?: string;
    actions: Array<{ name: string; description: string; parameters: Record<string, any> }>;
    hasHandler?: boolean;
  }

  let bridges = $state<ApiBridge[]>([]);
  let presets = $state<PresetInfo[]>([]);
  let loading = $state(true);

  // Form state
  let showForm = $state(false);
  let editingBridge = $state<ApiBridge | null>(null);
  let formType = $state<"preset" | "custom">("preset");
  let formPresetId = $state("");
  let formName = $state("");
  let formDisplayName = $state("");
  let formBaseUrl = $state("");
  let formApiKey = $state("");
  let formAuthType = $state("bearer");
  let formSaving = $state(false);

  // MCP form state
  let formBridgeMode = $state<"rest" | "mcp">("rest");
  let formMcpTransport = $state<"stdio" | "sse">("stdio");
  let formMcpCommand = $state("");
  let formMcpArgs = $state("");
  let formMcpEnv = $state("");
  let formMcpUrl = $state("");
  let formMcpHeaders = $state("");

  // Test state
  let testingId = $state<string | null>(null);

  onMount(loadData);

  async function loadData() {
    loading = true;
    try {
      const [b, p] = await Promise.all([
        api.apiBridges.list() as Promise<ApiBridge[]>,
        api.apiBridges.presets() as Promise<PresetInfo[]>,
      ]);
      bridges = b;
      presets = p;
    } catch (err: any) {
      toast.error(`Failed to load: ${err.message}`);
    } finally {
      loading = false;
    }
  }

  function openAdd(type: "preset" | "custom") {
    editingBridge = null;
    formType = type;
    formName = "";
    formDisplayName = "";
    formBaseUrl = "";
    formApiKey = "";
    formAuthType = "bearer";
    formBridgeMode = "rest";
    formMcpTransport = "stdio";
    formMcpCommand = "";
    formMcpArgs = "";
    formMcpEnv = "";
    formMcpUrl = "";
    formMcpHeaders = "";
    if (type === "preset" && presets.length > 0) {
      formPresetId = presets[0].presetId;
      formName = presets[0].presetId;
      formDisplayName = presets[0].displayName;
      formBaseUrl = presets[0].defaultBaseUrl;
    }
    showForm = true;
  }

  function openEdit(bridge: ApiBridge) {
    editingBridge = bridge;
    formType = bridge.type;
    formPresetId = bridge.presetId ?? "";
    formName = bridge.name;
    formDisplayName = bridge.displayName;
    formBaseUrl = bridge.baseUrl ?? "";
    formApiKey = "";
    formAuthType = bridge.authType;

    if (bridge.mcpConfig) {
      formBridgeMode = "mcp";
      formMcpTransport = bridge.mcpConfig.transport;
      formMcpCommand = bridge.mcpConfig.command ?? "";
      formMcpArgs = (bridge.mcpConfig.args ?? []).join("\n");
      formMcpEnv = bridge.mcpConfig.env
        ? Object.entries(bridge.mcpConfig.env).map(([k, v]) => `${k}=${v}`).join("\n")
        : "";
      formMcpUrl = bridge.mcpConfig.url ?? "";
      formMcpHeaders = bridge.mcpConfig.headers
        ? Object.entries(bridge.mcpConfig.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
        : "";
    } else {
      formBridgeMode = "rest";
      formMcpTransport = "stdio";
      formMcpCommand = "";
      formMcpArgs = "";
      formMcpEnv = "";
      formMcpUrl = "";
      formMcpHeaders = "";
    }

    showForm = true;
  }

  function onPresetChange() {
    const preset = presets.find((p) => p.presetId === formPresetId);
    if (preset) {
      formName = preset.presetId;
      formDisplayName = preset.displayName;
      formBaseUrl = preset.defaultBaseUrl;
      formAuthType = preset.authType ?? "bearer";
    }
  }

  /** Parse newline-separated key=value pairs into a Record. */
  function parseKeyValues(text: string, separator = "="): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const idx = line.indexOf(separator);
      if (idx > 0) {
        result[line.slice(0, idx).trim()] = line.slice(idx + separator.length).trim();
      }
    }
    return result;
  }

  async function saveForm() {
    formSaving = true;
    try {
      const data: Record<string, unknown> = {
        name: formName,
        displayName: formDisplayName,
        type: formType,
        authType: formAuthType,
        enabled: true,
      };

      if (formBridgeMode === "mcp" && formType === "custom") {
        const mcpConfig: Record<string, unknown> = { transport: formMcpTransport };
        if (formMcpTransport === "stdio") {
          mcpConfig.command = formMcpCommand;
          const args = formMcpArgs.split("\n").map((a) => a.trim()).filter(Boolean);
          if (args.length) mcpConfig.args = args;
          const env = parseKeyValues(formMcpEnv);
          if (Object.keys(env).length) mcpConfig.env = env;
        } else {
          mcpConfig.url = formMcpUrl;
          const headers = parseKeyValues(formMcpHeaders, ":");
          if (Object.keys(headers).length) mcpConfig.headers = headers;
        }
        data.mcpConfig = mcpConfig;
        data.authType = "none";
      } else {
        data.baseUrl = formBaseUrl;
        data.mcpConfig = null;
        if (formApiKey) data.apiKey = formApiKey;
      }

      if (formType === "preset") data.presetId = formPresetId;

      if (editingBridge) {
        await api.apiBridges.update(editingBridge.id, data);
        toast.success("Bridge updated");
      } else {
        await api.apiBridges.create(data);
        toast.success("Bridge created");
      }
      showForm = false;
      await loadData();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      formSaving = false;
    }
  }

  async function toggleEnabled(bridge: ApiBridge) {
    try {
      await api.apiBridges.update(bridge.id, { enabled: !bridge.enabled });
      toast.success(`${bridge.displayName} ${bridge.enabled ? "disabled" : "enabled"}`);
      await loadData();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function deleteBridge(bridge: ApiBridge) {
    if (!confirm(`Delete API bridge "${bridge.displayName}"?`)) return;
    try {
      await api.apiBridges.delete(bridge.id);
      toast.success("API bridge deleted");
      await loadData();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function testBridge(bridge: ApiBridge) {
    testingId = bridge.id;
    try {
      const result = (await api.apiBridges.test(bridge.id)) as { ok: boolean; status?: number; error?: string };
      if (result.ok) {
        toast.success(`${bridge.displayName}: connected (HTTP ${result.status ?? "OK"})`);
      } else {
        toast.error(`${bridge.displayName}: ${result.error ?? `HTTP ${result.status}`}`);
      }
    } catch (err: any) {
      toast.error(`Test failed: ${err.message}`);
    } finally {
      testingId = null;
    }
  }
</script>

<div class="page">
  <div class="page-header">
    <h1>API & MCP Bridges</h1>
    <p class="subtitle">Server-side integrations with external REST APIs, MCP servers, and preset services.</p>
    <div class="actions">
      <button class="btn primary" onclick={() => openAdd("preset")}>Add Preset Bridge</button>
      <button class="btn secondary" onclick={() => openAdd("custom")}>Add Custom Bridge</button>
      <button class="btn secondary" onclick={loadData}>Refresh</button>
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading...</div>
  {:else if bridges.length === 0}
    <div class="empty">
      <p>No API bridges configured.</p>
      <p class="muted">Add a preset integration or connect a custom REST API.</p>
    </div>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Base URL</th>
          <th>API Key</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each bridges as bridge}
          <tr class:disabled={!bridge.enabled}>
            <td>
              <strong>{bridge.displayName}</strong>
              <span class="slug">{bridge.name}</span>
            </td>
            <td>
              <span class="badge" class:preset={bridge.type === "preset"} class:mcp={!!bridge.mcpConfig}>
                {bridge.mcpConfig ? "mcp" : bridge.type}
              </span>
            </td>
            <td class="mono">
              {#if bridge.mcpConfig}
                {bridge.mcpConfig.transport === "stdio"
                  ? `${bridge.mcpConfig.command} ${(bridge.mcpConfig.args ?? []).join(" ")}`
                  : bridge.mcpConfig.url ?? ""}
              {:else}
                {bridge.baseUrl ?? ""}
              {/if}
            </td>
            <td>
              {#if bridge.mcpConfig}
                <span class="muted">N/A</span>
              {:else if bridge.authType === "none"}
                <span class="muted">N/A</span>
              {:else if bridge.hasApiKey}
                <span class="status-ok">Configured</span>
              {:else}
                <span class="status-warn">Missing</span>
              {/if}
            </td>
            <td>
              <span class="status-badge" class:enabled={bridge.enabled}>
                {bridge.enabled ? "Enabled" : "Disabled"}
              </span>
            </td>
            <td class="actions-cell">
              <button class="btn-sm" onclick={() => testBridge(bridge)} disabled={testingId === bridge.id}>
                {testingId === bridge.id ? "..." : "Test"}
              </button>
              <button class="btn-sm" onclick={() => openEdit(bridge)}>Edit</button>
              <button class="btn-sm" onclick={() => toggleEnabled(bridge)}>
                {bridge.enabled ? "Disable" : "Enable"}
              </button>
              <button class="btn-sm danger" onclick={() => deleteBridge(bridge)}>Delete</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <!-- Available Presets -->
  {#if presets.length > 0}
    <div class="presets-section">
      <h2>Available Presets</h2>
      <div class="preset-grid">
        {#each presets as preset}
          <div class="preset-card">
            <strong>{preset.displayName}</strong>
            {#if preset.description}
              <span class="preset-desc">{preset.description}</span>
            {/if}
            <span class="mono">{preset.defaultBaseUrl}</span>
            <div class="preset-actions">
              {#if preset.actions.length > 0}
                {#each preset.actions as action}
                  <span class="action-tag" title={action.description}>{action.name}</span>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<!-- Add/Edit Modal -->
{#if showForm}
  <Modal title="{editingBridge ? 'Edit' : 'Add'} {formType === 'preset' ? 'Preset' : 'Custom'} Bridge" open={showForm} onclose={() => (showForm = false)}>
    <div class="form">
      {#if formType === "preset" && !editingBridge}
        <label>
          Preset
          <select bind:value={formPresetId} onchange={onPresetChange}>
            {#each presets as preset}
              <option value={preset.presetId}>{preset.displayName}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if formType === "custom"}
        <label>
          Bridge Mode
          <div class="mode-toggle">
            <button class="mode-btn" class:active={formBridgeMode === "rest"} onclick={() => (formBridgeMode = "rest")}>
              REST API
            </button>
            <button class="mode-btn" class:active={formBridgeMode === "mcp"} onclick={() => (formBridgeMode = "mcp")}>
              MCP Server
            </button>
          </div>
        </label>
      {/if}

      <label>
        Name (slug)
        <input bind:value={formName} placeholder={formBridgeMode === "mcp" ? "my-mcp-server" : "meshy"} disabled={formType === "preset" && !editingBridge} />
      </label>

      <label>
        Display Name
        <input bind:value={formDisplayName} placeholder={formBridgeMode === "mcp" ? "My MCP Server" : "Meshy (3D Generation)"} />
      </label>

      {#if formBridgeMode === "mcp" && formType === "custom"}
        <label>
          Transport
          <select bind:value={formMcpTransport}>
            <option value="stdio">Command (stdio)</option>
            <option value="sse">URL (SSE/HTTP)</option>
          </select>
        </label>

        {#if formMcpTransport === "stdio"}
          <label>
            Command
            <input bind:value={formMcpCommand} placeholder="npx" />
            <span class="field-hint">The executable to run (e.g. npx, uvx, node, python)</span>
          </label>

          <label>
            Arguments (one per line)
            <textarea bind:value={formMcpArgs} rows="3" placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/tmp"}></textarea>
          </label>

          <label>
            Environment Variables (KEY=VALUE, one per line)
            <textarea bind:value={formMcpEnv} rows="2" placeholder="API_KEY=sk-xxx"></textarea>
          </label>
        {:else}
          <label>
            Server URL
            <input bind:value={formMcpUrl} placeholder="http://localhost:3001/sse" />
          </label>

          <label>
            Headers (Name: Value, one per line)
            <textarea bind:value={formMcpHeaders} rows="2" placeholder="Authorization: Bearer sk-xxx"></textarea>
          </label>
        {/if}
      {:else}
        <label>
          Base URL
          <input bind:value={formBaseUrl} placeholder="https://api.meshy.ai" />
        </label>

        <label>
          API Key
          <input type="password" bind:value={formApiKey} placeholder={editingBridge ? "(unchanged)" : "Enter API key"} />
        </label>

        <label>
          Auth Type
          <select bind:value={formAuthType}>
            <option value="bearer">Bearer Token</option>
            <option value="header">Custom Header</option>
            <option value="query">Query Parameter</option>
            <option value="none">None</option>
          </select>
        </label>
      {/if}

      <div class="form-actions">
        <button class="btn primary" onclick={saveForm} disabled={formSaving}>
          {formSaving ? "Saving..." : editingBridge ? "Update" : "Create"}
        </button>
        <button class="btn secondary" onclick={() => (showForm = false)}>Cancel</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .page { padding: 24px; }
  .page-header { margin-bottom: 24px; }
  .page-header h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  .subtitle { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
  .actions { display: flex; gap: 8px; }
  .loading, .empty { padding: 40px; text-align: center; color: var(--text-muted); font-size: 14px; }
  .empty .muted { font-size: 12px; }

  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .table th { text-align: left; padding: 8px 12px; color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
  .table td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .table tr.disabled { opacity: 0.5; }
  .table strong { display: block; color: var(--text-primary); }
  .slug { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, monospace); }
  .mono { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-secondary); }
  .actions-cell { white-space: nowrap; }

  .badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: var(--bg-elevated); color: var(--text-secondary); text-transform: uppercase; font-weight: 600; }
  .badge.preset { background: rgba(78, 201, 176, 0.15); color: var(--accent); }
  .badge.mcp { background: rgba(96, 165, 250, 0.15); color: #60a5fa; }
  .status-ok { color: var(--accent); font-size: 12px; font-weight: 600; }
  .status-warn { color: var(--warning, #f0ad4e); font-size: 12px; font-weight: 600; }
  .status-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; background: rgba(102, 102, 102, 0.15); color: var(--text-muted); }
  .status-badge.enabled { background: rgba(78, 201, 176, 0.15); color: var(--accent); }

  .btn { padding: 6px 14px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; font-weight: 500; }
  .btn.primary { background: var(--accent); color: white; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.secondary { background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); }
  .btn.secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-sm { padding: 3px 8px; font-size: 11px; border-radius: 3px; background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); cursor: pointer; }
  .btn-sm:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm.danger:hover { background: rgba(231, 76, 60, 0.15); color: #e74c3c; border-color: #e74c3c; }

  .presets-section { margin-top: 32px; }
  .presets-section h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--text-secondary); }
  .preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .preset-card { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); }
  .preset-card strong { display: block; font-size: 14px; margin-bottom: 2px; }
  .preset-desc { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 2px; }
  .preset-actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
  .action-tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-secondary); font-family: var(--font-mono, monospace); }

  .form { display: flex; flex-direction: column; gap: 12px; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-secondary); }
  .form input, .form select { padding: 6px 8px; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; }
  .form input:disabled { opacity: 0.5; }
  .form textarea { padding: 6px 8px; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; font-family: var(--font-mono, monospace); resize: vertical; }
  .form-actions { display: flex; gap: 8px; margin-top: 4px; }

  .mode-toggle { display: flex; gap: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .mode-btn { flex: 1; padding: 5px 12px; font-size: 13px; background: var(--bg-base); color: var(--text-secondary); cursor: pointer; border: none; border-right: 1px solid var(--border); }
  .mode-btn:last-child { border-right: none; }
  .mode-btn.active { background: var(--accent); color: white; }
  .field-hint { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
</style>
