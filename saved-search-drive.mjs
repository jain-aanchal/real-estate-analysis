// Saved searches — server-side helpers (Drive R/W happens client-side)
// =============================================================================
// The browser owns the user's Google OAuth token (see existing Save-Analysis
// modal). All Drive R/W therefore runs in the client. This module exists to
// satisfy the server import and to provide a localStorage-only fallback shape
// the client can use when offline.
// =============================================================================

export async function saveSearch({ name, filters }) {
  // No-op server side. Client persists via Drive (or localStorage fallback).
  return { ok: true, name };
}

export async function listSearches() {
  return [];  // Client owns this list
}

export async function deleteSearch({ name }) {
  return { ok: true, name };
}
