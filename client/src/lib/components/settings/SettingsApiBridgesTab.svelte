<script lang="ts">
  import { connection } from "../../stores/connection.svelte";
  import { api } from "../../api/rest";
  import Badge from "../ui/Badge.svelte";

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
  }

  interface PresetInfo {
    presetId: string;
    displayName: string;
    defaultBaseUrl: string;
    authType?: string;
    description?: string;
    actions: Array<{ name: string; description: string }>;
    hasHandler?: boolean;
  }

  let bridges = $state<ApiBridge[]>([]);
  let presets = $state<PresetInfo[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state("");

  // Add/edit form state
  let showForm = $state(false);
  let editingId = $state<string | null>(null);
  let formType = $state<"preset" | "custom">("preset");
  let formPresetId = $state("");
  let formName = $state("");
  let formDisplayName = $state("");
  let formBaseUrl = $state("");
  let formApiKey = $state("");
  let formAuthType = $state("bearer");
  let formSaving = $state(false);
  let formError = $state("");

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
  let testResult = $state<{ ok: boolean; status?: number; error?: string } | null>(null);

  $effect(() => {
    if (connection.isAuthenticated && !loaded) {
      loaded = true;
      void loadData();
    }
  });

  async function loadData() {
    loading = true;
    error = "";
    try {
      const [bridgeResult, presetResult] = await Promise.all([
        api.apiBridges.list(),
        api.apiBridges.presets(),
      ]);
      bridges = bridgeResult as ApiBridge[];
      presets = presetResult as PresetInfo[];
    } catch (err: any) {
      error = err.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  function openAddForm(type: "preset" | "custom") {
    editingId = null;
    formType = type;
    formPresetId = presets[0]?.presetId ?? "";
    formName = "";
    formDisplayName = "";
    formBaseUrl = "";
    formApiKey = "";
    formAuthType = "bearer";
    formError = "";
    formBridgeMode = "rest";
    formMcpTransport = "stdio";
    formMcpCommand = "";
    formMcpArgs = "";
    formMcpEnv = "";
    formMcpUrl = "";
    formMcpHeaders = "";
    showForm = true;

    if (type === "preset" && presets.length > 0) {
      selectPreset(presets[0].presetId);
    }
  }

  function selectPreset(presetId: string) {
    formPresetId = presetId;
    const preset = presets.find((p) => p.presetId === presetId);
    if (preset) {
      formName = preset.presetId;
      formDisplayName = preset.displayName;
      formBaseUrl = preset.defaultBaseUrl;
      formAuthType = preset.authType ?? "bearer";
    }
  }

  function openEditForm(bridge: ApiBridge) {
    editingId = bridge.id;
    formType = bridge.type;
    formPresetId = bridge.presetId ?? "";
    formName = bridge.name;
    formDisplayName = bridge.displayName;
    formBaseUrl = bridge.baseUrl ?? "";
    formApiKey = "";
    formAuthType = bridge.authType;
    formError = "";

    // MCP state
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
    formError = "";
    try {
      const data: Record<string, unknown> = {
        name: formName,
        displayName: formDisplayName,
        type: formType,
        authType: formAuthType,
        enabled: true,
      };

      if (formBridgeMode === "mcp" && formType === "custom") {
        // MCP bridge — build mcpConfig, no baseUrl needed
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
        // REST bridge
        data.baseUrl = formBaseUrl;
        data.mcpConfig = null; // clear MCP config if switching from MCP to REST
        if (formApiKey) data.apiKey = formApiKey;
      }

      if (formType === "preset") data.presetId = formPresetId;

      if (editingId) {
        await api.apiBridges.update(editingId, data);
      } else {
        await api.apiBridges.create(data);
      }
      showForm = false;
      await loadData();
    } catch (err: any) {
      formError = err.message ?? String(err);
    } finally {
      formSaving = false;
    }
  }

  async function toggleEnabled(bridge: ApiBridge) {
    try {
      await api.apiBridges.update(bridge.id, { enabled: !bridge.enabled });
      await loadData();
    } catch (err: any) {
      error = err.message ?? String(err);
    }
  }

  async function deleteBridge(bridge: ApiBridge) {
    if (!confirm(`Delete API bridge "${bridge.displayName}"?`)) return;
    try {
      await api.apiBridges.delete(bridge.id);
      await loadData();
    } catch (err: any) {
      error = err.message ?? String(err);
    }
  }

  async function testBridge(bridge: ApiBridge) {
    testingId = bridge.id;
    testResult = null;
    try {
      testResult = (await api.apiBridges.test(bridge.id)) as any;
    } catch (err: any) {
      testResult = { ok: false, error: err.message ?? String(err) };
    } finally {
      testingId = null;
    }
  }
</script>

<section>
  <h3>API & MCP Bridges</h3>
  <p class="desc">
    Connect to external APIs and MCP servers as bridge targets. Unlike program bridges (Blender, Godot, etc.) which run inside DCC apps,
    API bridges call external services directly from the server — no plugin installation required.
  </p>

  {#if loading}
    <div class="empty-state">Loading...</div>
  {:else if error}
    <div class="error-state">{error}</div>
  {:else if bridges.length === 0}
    <div class="empty-state">
      No API bridges configured. Add a preset (like Meshy for 3D generation) or connect any custom REST API.
    </div>
  {:else}
    <div class="bridge-list">
      {#each bridges as bridge}
        <div class="bridge-item" class:disabled={!bridge.enabled}>
          <div class="bridge-item-left">
            <Badge
              text={bridge.mcpConfig ? "MCP" : bridge.type === "preset" ? bridge.presetId ?? "preset" : "CUSTOM"}
              variant={bridge.mcpConfig ? "info" : bridge.type === "preset" ? "accent" : "default"}
            />
            <div class="bridge-info">
              <span class="bridge-name">{bridge.displayName}</span>
              <span class="bridge-url">
                {#if bridge.mcpConfig}
                  {bridge.mcpConfig.transport === "stdio"
                    ? `${bridge.mcpConfig.command} ${(bridge.mcpConfig.args ?? []).join(" ")}`
                    : bridge.mcpConfig.url ?? ""}
                {:else}
                  {bridge.baseUrl ?? ""}
                {/if}
              </span>
            </div>
          </div>
          <div class="bridge-item-right">
            {#if !bridge.mcpConfig && !bridge.hasApiKey && bridge.authType !== "none"}
              <span class="bridge-warning">No API key</span>
            {/if}
            <span class="bridge-state" class:enabled={bridge.enabled}>
              {bridge.enabled ? "enabled" : "disabled"}
            </span>
            <button class="btn-sm" onclick={() => testBridge(bridge)} disabled={testingId === bridge.id}>
              {testingId === bridge.id ? "..." : "Test"}
            </button>
            <button class="btn-sm" onclick={() => openEditForm(bridge)}>Edit</button>
            <button class="btn-sm" onclick={() => toggleEnabled(bridge)}>
              {bridge.enabled ? "Disable" : "Enable"}
            </button>
            <button class="btn-sm danger" onclick={() => deleteBridge(bridge)}>Delete</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if testResult}
    <div class="test-result" class:success={testResult.ok} class:failure={!testResult.ok}>
      {#if testResult.ok}
        Connected successfully{testResult.status ? ` (HTTP ${testResult.status})` : ""}
      {:else}
        Connection failed: {testResult.error ?? `HTTP ${testResult.status}`}
      {/if}
    </div>
  {/if}

  <div class="actions-bar">
    <button class="btn" onclick={() => openAddForm("preset")}>
      Add Preset Bridge
    </button>
    <button class="btn secondary" onclick={() => openAddForm("custom")}>
      Add Custom Bridge
    </button>
    <button class="btn secondary" onclick={loadData}>
      Refresh
    </button>
  </div>
</section>

<!-- Available Presets -->
{#if presets.length > 0}
  <section>
    <h3>Available Presets</h3>
    <p class="desc">Integrations with popular APIs. Click "Add Preset Bridge" above to configure one.</p>
    <div class="preset-list">
      {#each presets as preset}
        <div class="preset-item">
          <div class="preset-info">
            <span class="preset-name">{preset.displayName}</span>
            {#if preset.description}
              <span class="preset-desc">{preset.description}</span>
            {/if}
            <span class="preset-url">{preset.defaultBaseUrl}</span>
          </div>
          <div class="preset-actions">
            {#if preset.actions.length > 0}
              {#each preset.actions as action}
                <span class="preset-action">{action.name}</span>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}

<!-- Add/Edit Form Modal -->
{#if showForm}
  <div class="form-overlay" onclick={() => (showForm = false)} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="form-modal" onclick={(e) => e.stopPropagation()} role="dialog">
      <h3>{editingId ? "Edit" : "Add"} {formType === "preset" ? "Preset" : "Custom"} Bridge</h3>

      {#if formType === "preset" && !editingId}
        <label>
          Preset
          <select bind:value={formPresetId} onchange={() => selectPreset(formPresetId)}>
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
        <input bind:value={formName} placeholder={formBridgeMode === "mcp" ? "my-mcp-server" : "meshy"} disabled={formType === "preset" && !editingId} />
      </label>

      <label>
        Display Name
        <input bind:value={formDisplayName} placeholder={formBridgeMode === "mcp" ? "My MCP Server" : "Meshy (3D Generation)"} />
      </label>

      {#if formBridgeMode === "mcp" && formType === "custom"}
        <!-- MCP-specific fields -->
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
        <!-- REST API fields -->
        <label>
          Base URL
          <input bind:value={formBaseUrl} placeholder="https://api.meshy.ai" />
        </label>

        <label>
          API Key
          <input type="password" bind:value={formApiKey} placeholder={editingId ? "(unchanged)" : "Enter API key"} />
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

      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}

      <div class="form-actions">
        <button class="btn" onclick={saveForm} disabled={formSaving}>
          {formSaving ? "Saving..." : editingId ? "Update" : "Create"}
        </button>
        <button class="btn secondary" onclick={() => (showForm = false)}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  section {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 16px;
  }
  h3 {
    font-size: var(--font-size-base);
    margin-bottom: 12px;
    color: var(--text-secondary);
  }
  .desc {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .empty-state {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    padding: 16px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 10px;
  }
  .error-state {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    padding: 10px;
    border: 1px solid var(--status-failed);
    border-radius: var(--radius-sm);
    margin-bottom: 10px;
  }

  /* Bridge list */
  .bridge-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 10px;
  }
  .bridge-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    border: 1px solid var(--border);
    gap: 8px;
  }
  .bridge-item.disabled {
    opacity: 0.5;
  }
  .bridge-item-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .bridge-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .bridge-name {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bridge-url {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bridge-item-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .bridge-state {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .bridge-state.enabled {
    border-color: var(--status-completed);
    color: var(--status-completed);
  }
  .bridge-warning {
    font-size: 11px;
    color: var(--status-failed);
    font-weight: 600;
  }

  /* Buttons */
  .actions-bar {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .btn {
    padding: 6px 16px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn.secondary {
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .btn.secondary:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-sm {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .btn-sm:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-sm.danger:hover {
    background: rgba(244, 67, 54, 0.15);
    color: var(--status-failed);
    border-color: var(--status-failed);
  }

  /* Test result */
  .test-result {
    font-size: var(--font-size-sm);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    margin-bottom: 10px;
  }
  .test-result.success {
    background: rgba(78, 201, 176, 0.1);
    color: var(--status-completed);
    border: 1px solid var(--status-completed);
  }
  .test-result.failure {
    background: rgba(244, 67, 54, 0.1);
    color: var(--status-failed);
    border: 1px solid var(--status-failed);
  }

  /* Presets */
  .preset-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .preset-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    border: 1px solid var(--border);
  }
  .preset-info {
    display: flex;
    flex-direction: column;
  }
  .preset-name {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    font-weight: 600;
  }
  .preset-desc {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.3;
  }
  .preset-url {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .preset-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .preset-action {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  /* Form modal */
  .form-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .form-modal {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 20px;
    min-width: 420px;
    max-width: 520px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form-modal h3 {
    margin-bottom: 0;
  }
  .form-modal label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .form-modal input,
  .form-modal select {
    padding: 6px 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .form-modal input:disabled {
    opacity: 0.5;
  }
  .form-error {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
  }
  .form-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  /* Mode toggle */
  .mode-toggle {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .mode-btn {
    flex: 1;
    padding: 5px 12px;
    font-size: var(--font-size-sm);
    background: var(--bg-base);
    color: var(--text-secondary);
    cursor: pointer;
    border: none;
    border-right: 1px solid var(--border);
  }
  .mode-btn:last-child { border-right: none; }
  .mode-btn.active {
    background: var(--accent);
    color: white;
  }

  /* Textarea and hints */
  .form-modal textarea {
    padding: 6px 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    resize: vertical;
  }
  .field-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }
</style>
