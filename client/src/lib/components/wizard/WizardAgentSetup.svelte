<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../api/rest";
  import { wizard } from "../../stores/wizard.svelte";

  interface OnboardingLink {
    label: string;
    url: string;
  }

  interface AgentTemplate {
    id: string;
    name: string;
    description: string;
    engine: string;
    command: string;
    args: string[];
    model?: string;
    maxTurns: number;
    priority: number;
    onboarding?: {
      title: string;
      steps: string[];
      links?: OnboardingLink[];
      commands?: string[];
    };
  }

  interface CliAuthState {
    provider: string;
    authenticated: boolean;
    user?: string;
  }

  let templates = $state<AgentTemplate[]>([]);
  let existingConfigs = $state<any[]>([]);
  let cliAuth = $state<CliAuthState[]>([]);
  let selected = $state<Set<string>>(new Set());
  let loading = $state(true);
  let creating = $state(false);
  let error = $state("");
  let createdIds = $state<Set<string>>(new Set());
  let expandedTemplate = $state<string | null>(null);

  onMount(async () => {
    try {
      const [tplRes, configRes] = await Promise.all([
        api.agents.templates(),
        api.agents.list(),
      ]);
      templates = (tplRes as any)?.templates ?? tplRes ?? [];
      existingConfigs = (configRes as any)?.configs ?? configRes ?? [];

      // Try fetching CLI auth status (may fail if user doesn't have manageAgents)
      try {
        const authRes = await api.agents.cliAuthStatus();
        cliAuth = (authRes as any)?.providers ?? [];
      } catch {
        // Non-admin users won't have access — that's fine
      }

      // Pre-select templates that don't already have a config
      const existingEngines = new Set(existingConfigs.map((c: any) => c.engine));
      for (const tpl of templates) {
        // Skip local model templates from auto-select
        if (tpl.engine === "local-oss") continue;
        if (!existingEngines.has(tpl.engine)) {
          // Check if CLI auth says this provider is authenticated
          const auth = cliAuth.find((a) => a.provider === tpl.engine);
          if (auth?.authenticated) {
            selected.add(tpl.id);
          }
        }
      }
    } catch (err: any) {
      error = `Failed to load templates: ${err.message}`;
    } finally {
      loading = false;
    }
  });

  function toggleTemplate(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selected = next;
  }

  function toggleExpand(id: string) {
    expandedTemplate = expandedTemplate === id ? null : id;
  }

  function getAuthStatus(engine: string): CliAuthState | undefined {
    return cliAuth.find((a) => a.provider === engine);
  }

  function engineAlreadyConfigured(engine: string): boolean {
    return existingConfigs.some((c: any) => c.engine === engine);
  }

  async function addSelectedAgents() {
    error = "";
    creating = true;
    let count = 0;
    try {
      for (const tpl of templates) {
        if (!selected.has(tpl.id)) continue;
        if (engineAlreadyConfigured(tpl.engine)) {
          createdIds.add(tpl.id);
          count++;
          continue;
        }
        await api.agents.create({
          name: tpl.name,
          engine: tpl.engine,
          command: tpl.command,
          args: tpl.args,
          model: tpl.model || undefined,
          maxTurns: tpl.maxTurns,
          priority: tpl.priority,
        });
        createdIds.add(tpl.id);
        count++;
      }
      wizard.agentsCreated = count;
    } catch (err: any) {
      error = `Failed to create agent config: ${err.message}`;
    } finally {
      creating = false;
    }
  }
</script>

<div class="agent-setup">
  <h3>Configure AI Agents</h3>
  <p class="subtitle">Select which AI providers you have access to. Agent configs will be created on the server.</p>

  {#if loading}
    <div class="loading">Loading templates...</div>
  {:else if error && templates.length === 0}
    <div class="error">{error}</div>
  {:else}
    <div class="template-list">
      {#each templates as tpl (tpl.id)}
        {@const alreadyExists = engineAlreadyConfigured(tpl.engine)}
        {@const isCreated = createdIds.has(tpl.id)}
        {@const auth = getAuthStatus(tpl.engine)}
        <div
          class="template-card"
          class:selected={selected.has(tpl.id)}
          class:created={isCreated}
          class:disabled={alreadyExists && !isCreated}
        >
          <div class="template-header">
            <label class="template-check">
              <input
                type="checkbox"
                checked={selected.has(tpl.id) || isCreated}
                disabled={isCreated || (alreadyExists && !isCreated)}
                onchange={() => toggleTemplate(tpl.id)}
              />
              <div class="template-info">
                <span class="template-name">{tpl.name}</span>
                <span class="template-desc">{tpl.description}</span>
              </div>
            </label>
            <div class="template-badges">
              {#if isCreated}
                <span class="badge created">Added</span>
              {:else if alreadyExists}
                <span class="badge exists">Already configured</span>
              {/if}
              {#if auth}
                <span class="badge" class:authed={auth.authenticated} class:unauthed={!auth.authenticated}>
                  {auth.authenticated ? "Authenticated" : "Needs login"}
                </span>
              {/if}
            </div>
          </div>

          {#if tpl.onboarding}
            <button class="expand-btn" onclick={() => toggleExpand(tpl.id)}>
              {expandedTemplate === tpl.id ? "Hide" : "Setup"} instructions
              <span class="chevron" class:open={expandedTemplate === tpl.id}>&#9662;</span>
            </button>
            {#if expandedTemplate === tpl.id}
              <div class="onboarding">
                <ol>
                  {#each tpl.onboarding.steps as step}
                    <li>{step}</li>
                  {/each}
                </ol>
                {#if tpl.onboarding.commands?.length}
                  <div class="commands">
                    {#each tpl.onboarding.commands as cmd}
                      <code>{cmd}</code>
                    {/each}
                  </div>
                {/if}
                {#if tpl.onboarding.links?.length}
                  <div class="links">
                    {#each tpl.onboarding.links as link}
                      <a href={link.url} target="_blank" rel="noopener">{link.label}</a>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button
        class="btn primary"
        disabled={selected.size === 0 || creating || (createdIds.size > 0 && createdIds.size >= selected.size)}
        onclick={addSelectedAgents}
      >
        {creating ? "Adding..." : createdIds.size > 0 ? "Added!" : `Add ${selected.size} Agent${selected.size === 1 ? "" : "s"}`}
      </button>
      <span class="skip-hint">You can also configure agents later in the Admin panel.</span>
    </div>
  {/if}
</div>

<style>
  .agent-setup {
    text-align: left;
  }
  h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }
  .subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 16px;
  }
  .loading {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
    padding: 24px 0;
  }
  .error {
    font-size: 12px;
    color: #ff9d9d;
    padding: 8px;
    background: rgba(244, 71, 71, 0.1);
    border-radius: var(--radius-sm);
    margin-top: 8px;
  }
  .template-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 340px;
    overflow-y: auto;
  }
  .template-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    background: var(--bg-base);
    transition: border-color 0.15s;
  }
  .template-card.selected {
    border-color: var(--accent);
  }
  .template-card.created {
    border-color: #4ade80;
    opacity: 0.8;
  }
  .template-card.disabled {
    opacity: 0.5;
  }
  .template-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .template-check {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    flex: 1;
    cursor: pointer;
  }
  .template-check input {
    margin-top: 3px;
    flex-shrink: 0;
  }
  .template-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .template-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .template-desc {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.3;
  }
  .template-badges {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .badge.created {
    background: rgba(74, 222, 128, 0.15);
    color: #4ade80;
  }
  .badge.exists {
    background: var(--bg-hover);
    color: var(--text-muted);
  }
  .badge.authed {
    background: rgba(74, 222, 128, 0.15);
    color: #4ade80;
  }
  .badge.unauthed {
    background: rgba(250, 204, 21, 0.15);
    color: #facc15;
  }
  .expand-btn {
    font-size: 11px;
    color: var(--text-muted);
    background: none;
    border: none;
    padding: 4px 0 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .expand-btn:hover {
    color: var(--text-secondary);
  }
  .chevron {
    font-size: 10px;
    transition: transform 0.15s;
  }
  .chevron.open {
    transform: rotate(180deg);
  }
  .onboarding {
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .onboarding ol {
    margin: 0;
    padding-left: 18px;
  }
  .onboarding li {
    line-height: 1.5;
    margin-bottom: 2px;
  }
  .commands {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .commands code {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 3px 6px;
    color: var(--text-primary);
    word-break: break-all;
  }
  .links {
    margin-top: 6px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .links a {
    font-size: 11px;
    color: var(--accent);
    text-decoration: none;
  }
  .links a:hover {
    text-decoration: underline;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .skip-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
  }
  .btn.primary:hover {
    filter: brightness(1.08);
  }
  .btn.primary:disabled {
    opacity: 0.5;
    cursor: default;
    filter: none;
  }
</style>
