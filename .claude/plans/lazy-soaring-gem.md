# Plan: Job Collapsing in Client Jobs UI

## Context
Jobs with sub-jobs (via `parentJobId`) are rendered as a flattened tree with indentation, but there's no way to collapse/expand parent jobs to hide their children. With training and housekeeping generating chains of sub-jobs, the list gets noisy.

## Changes (all in `client/src/pages/Jobs.svelte`)

### 1. Add collapsed state
- `let collapsedParents = $state(new Set<string>())` — tracks which parent job IDs are collapsed
- Toggle function: `toggleCollapse(jobId)` — adds/removes from set

### 2. Filter flatNodes to skip collapsed children
- In the `flatNodes` derived, during the `walk()` function, skip recursing into children when the parent is in `collapsedParents`
- The parent node itself still renders (so you can click to expand)

### 3. Add collapse toggle chevron on parent rows
- On rows where `delegation.childCount > 0` (parent jobs), add a clickable chevron icon before the job name
- `▶` when collapsed, `▼` when expanded
- Click stops propagation (doesn't select the job)

### 4. Auto-collapse by default
- Parent jobs with children start collapsed — cleaner default view
- User clicks chevron to expand

## Files
- `client/src/pages/Jobs.svelte` — only file modified

## Verification
- Parent jobs show chevron + "N sub" badge
- Clicking chevron expands/collapses children
- Expanding shows indented sub-jobs with connector lines
- Selecting a parent job still works (doesn't toggle collapse)
- Multi-level nesting works (grandchildren hidden when grandparent collapsed)
