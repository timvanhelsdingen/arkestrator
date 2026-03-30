---
name: Client skills view must match admin detail
description: User has repeatedly asked for client skills detail modal to show the same fields as admin — keywords, auto-fetch, name, source path, description
type: feedback
---

Client Coordinator skills detail modal must stay in parity with the admin Skills detail view. When adding fields to admin, always add them to the client too.

**Why:** User has asked for this "a gazillion times" — it keeps being missed when new fields are added to the admin side.

**How to apply:** After any change to admin/src/pages/Skills.svelte detail modal, check client/src/pages/Coordinator.svelte skill detail modal and ensure it shows the same metadata fields (keywords, auto-fetch, name, source path, description, etc.).
