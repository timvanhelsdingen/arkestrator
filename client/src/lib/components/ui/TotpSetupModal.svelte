<script lang="ts">
  import { api } from "../../api/rest";
  import QRCode from "qrcode";

  interface Props {
    open: boolean;
    forced?: boolean;
    onclose: () => void;
    oncomplete: () => void;
  }

  let {
    open,
    forced = false,
    onclose,
    oncomplete,
  }: Props = $props();

  let step: 1 | 2 | 3 = $state(1);
  let loading = $state(false);
  let error = $state("");

  // Step 1 state
  let secret = $state("");
  let qrDataUrl = $state("");
  let recoveryCodes: string[] = $state([]);

  // Step 2 state
  let verifyCode = $state("");
  let verifying = $state(false);

  // Step 3 state
  let codesAcknowledged = $state(false);
  let copyLabel = $state("Copy All");

  // Input ref for auto-focus
  let codeInput: HTMLInputElement | undefined = $state(undefined);

  $effect(() => {
    if (open) {
      // Reset state when opened
      step = 1;
      loading = false;
      error = "";
      secret = "";
      qrDataUrl = "";
      recoveryCodes = [];
      verifyCode = "";
      verifying = false;
      codesAcknowledged = false;
      copyLabel = "Copy All";
      startSetup();
    }
  });

  $effect(() => {
    if (step === 2 && codeInput) {
      codeInput.focus();
    }
  });

  async function startSetup() {
    loading = true;
    error = "";
    try {
      const res = await api.auth.totpSetup();
      secret = res.secret;
      recoveryCodes = res.recoveryCodes;
      qrDataUrl = await QRCode.toDataURL(res.uri, { width: 200, margin: 2 });
    } catch (e: any) {
      error = e.message || "Failed to start TOTP setup";
    } finally {
      loading = false;
    }
  }

  async function handleVerify() {
    const code = verifyCode.trim();
    if (code.length !== 6) {
      error = "Please enter a 6-digit code";
      return;
    }
    verifying = true;
    error = "";
    try {
      await api.auth.totpVerifySetup(code);
      step = 3;
    } catch (e: any) {
      error = e.message || "Verification failed. Please try again.";
    } finally {
      verifying = false;
    }
  }

  async function handleCopyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      copyLabel = "Copied!";
      setTimeout(() => (copyLabel = "Copy All"), 2000);
    } catch {
      // Fallback: select text for manual copy
      copyLabel = "Failed to copy";
      setTimeout(() => (copyLabel = "Copy All"), 2000);
    }
  }

  async function handleCopySecret() {
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // silent fail
    }
  }

  function handleClose() {
    if (!forced) onclose();
  }

  function handleDone() {
    if (codesAcknowledged) oncomplete();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape" && !forced) onclose();
    if (e.key === "Enter" && step === 2 && !verifying) handleVerify();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={forced ? undefined : handleClose}>
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <div class="header">
        <h3>Set Up Two-Factor Authentication</h3>
        {#if !forced}
          <button class="close-btn" onclick={handleClose}>&times;</button>
        {/if}
      </div>

      <div class="steps-indicator">
        <span class="step-dot" class:active={step >= 1}></span>
        <span class="step-line" class:active={step >= 2}></span>
        <span class="step-dot" class:active={step >= 2}></span>
        <span class="step-line" class:active={step >= 3}></span>
        <span class="step-dot" class:active={step >= 3}></span>
      </div>

      {#if step === 1}
        <div class="step-content">
          {#if loading}
            <div class="loading-state">
              <p>Generating setup code...</p>
            </div>
          {:else if error && !qrDataUrl}
            <div class="error-state">
              <p class="error-msg">{error}</p>
              <button class="btn primary" onclick={startSetup}>Retry</button>
            </div>
          {:else}
            <p class="step-description">
              Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
            </p>
            <div class="qr-container">
              <img src={qrDataUrl} alt="TOTP QR Code" class="qr-image" />
            </div>
            <div class="manual-entry">
              <span class="manual-label">Or enter this code manually:</span>
              <div class="secret-row">
                <code class="secret-text">{secret}</code>
                <button class="btn-copy" onclick={handleCopySecret} title="Copy secret">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </div>
            </div>
            <div class="actions">
              {#if !forced}
                <button class="btn secondary" onclick={handleClose}>Cancel</button>
              {/if}
              <button class="btn primary" onclick={() => { step = 2; error = ""; verifyCode = ""; }}>Next</button>
            </div>
          {/if}
        </div>
      {:else if step === 2}
        <div class="step-content">
          <p class="step-description">Enter the code from your authenticator app</p>
          <div class="verify-form">
            <input
              bind:this={codeInput}
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="000000"
              bind:value={verifyCode}
              class="code-input"
              autocomplete="one-time-code"
              disabled={verifying}
            />
            {#if error}
              <p class="error-msg">{error}</p>
            {/if}
          </div>
          <div class="actions">
            <button class="btn secondary" onclick={() => { step = 1; error = ""; }} disabled={verifying}>Back</button>
            <button class="btn primary" onclick={handleVerify} disabled={verifying || verifyCode.trim().length !== 6}>
              {verifying ? "Verifying..." : "Verify"}
            </button>
          </div>
        </div>
      {:else if step === 3}
        <div class="step-content">
          <p class="step-description">
            Save these recovery codes in a safe place. Each code can only be used once.
          </p>
          <div class="recovery-codes">
            {#each recoveryCodes as code}
              <span class="recovery-code">{code}</span>
            {/each}
          </div>
          <button class="btn secondary copy-all-btn" onclick={handleCopyCodes}>{copyLabel}</button>
          <label class="acknowledge-row">
            <input type="checkbox" bind:checked={codesAcknowledged} />
            <span>I have saved my recovery codes</span>
          </label>
          <div class="actions">
            <button class="btn primary" onclick={handleDone} disabled={!codesAcknowledged}>Done</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 500;
  }

  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    min-width: 340px;
    max-width: 440px;
    width: 100%;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    margin: 0;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  .steps-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: 20px;
  }

  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bg-hover);
    transition: background 0.15s;
  }

  .step-dot.active {
    background: var(--accent);
  }

  .step-line {
    width: 32px;
    height: 2px;
    background: var(--bg-hover);
    transition: background 0.15s;
  }

  .step-line.active {
    background: var(--accent);
  }

  .step-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .step-description {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }

  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 0;
  }

  .loading-state p {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0;
  }

  .qr-container {
    display: flex;
    justify-content: center;
    padding: 8px 0;
  }

  .qr-image {
    border-radius: var(--radius-md);
    background: white;
    padding: 4px;
  }

  .manual-entry {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .manual-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .secret-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }

  .secret-text {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    word-break: break-all;
    flex: 1;
  }

  .btn-copy {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .btn-copy:hover {
    color: var(--text-primary);
  }

  .verify-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .code-input {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 20px;
    letter-spacing: 6px;
    padding: 10px 16px;
  }

  .error-msg {
    font-size: var(--font-size-sm);
    color: var(--status-failed);
    margin: 0;
  }

  .recovery-codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
  }

  .recovery-code {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    text-align: center;
    padding: 4px 0;
  }

  .copy-all-btn {
    align-self: flex-start;
  }

  .acknowledge-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .acknowledge-row input[type="checkbox"] {
    cursor: pointer;
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .btn {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 500;
    cursor: pointer;
    border: none;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.primary {
    background: var(--accent);
    color: white;
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn.secondary {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn.secondary:hover:not(:disabled) {
    opacity: 0.85;
  }
</style>
