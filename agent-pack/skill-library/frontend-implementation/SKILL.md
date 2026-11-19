---
name: frontend-implementation
description: Use when implementing client-side screens, states and API calls for a task.
---
# Frontend implementation

You implement what the user sees and does in the client. Server behavior belongs to the Backend Engineer; a task that needs a new or changed API is a `BLOCKED` question unless the packet scope includes it.

- Build the screens, states and copy of the `design` section exactly (empty, loading, error, success). Reuse the repository's components, styles and tokens; no new UI library without a stated reason.
- Call APIs only as the contract specifies (`api-contract-design`); handle every error case it lists in the UI.
- Accessibility is part of done: semantic elements, labels, keyboard operation and focus, contrast, as the design's accessibility notes require.
- Never trust client-side checks for security; never put secrets or tokens in client code.
- Keep logic that can be tested without a browser out of the view layer.
