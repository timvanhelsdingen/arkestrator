<script lang="ts">
  import { marked } from "marked";

  let { content }: { content: string } = $props();

  // Configure marked for safe output (HTML is escaped by default in marked v14+)
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let html = $derived(marked.parse(content) as string);
</script>

<div class="markdown-body">
  {@html html}
</div>

<style>
  .markdown-body {
    font-family: var(--font-sans);
    font-size: var(--font-size-sm);
    line-height: 1.6;
    color: var(--text-primary);
    word-break: break-word;
  }
  .markdown-body :global(p) {
    margin: 0.4em 0;
  }
  .markdown-body :global(p:first-child) {
    margin-top: 0;
  }
  .markdown-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4) {
    margin: 0.6em 0 0.3em;
    color: var(--text-primary);
    font-weight: 600;
  }
  .markdown-body :global(h1) { font-size: 1.25em; }
  .markdown-body :global(h2) { font-size: 1.15em; }
  .markdown-body :global(h3) { font-size: 1.05em; }
  .markdown-body :global(h4) { font-size: 1em; }
  .markdown-body :global(strong) {
    font-weight: 600;
    color: var(--text-primary);
  }
  .markdown-body :global(em) {
    font-style: italic;
  }
  .markdown-body :global(a) {
    color: var(--accent);
    text-decoration: none;
  }
  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }
  .markdown-body :global(code) {
    background: var(--bg-base);
    padding: 2px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
  .markdown-body :global(pre) {
    background: var(--bg-base);
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    margin: 0.5em 0;
  }
  .markdown-body :global(pre code) {
    background: none;
    padding: 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .markdown-body :global(blockquote) {
    border-left: 3px solid var(--accent);
    margin: 0.5em 0;
    padding: 0.3em 0 0.3em 12px;
    color: var(--text-muted);
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.4em 0;
    padding-left: 1.5em;
  }
  .markdown-body :global(li) {
    margin: 0.15em 0;
  }
  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.8em 0;
  }
  .markdown-body :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.5em 0;
    font-size: 0.9em;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--border);
    padding: 4px 8px;
    text-align: left;
  }
  .markdown-body :global(th) {
    background: var(--bg-base);
    font-weight: 600;
  }
</style>
