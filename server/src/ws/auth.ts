import type { ApiKeysRepo } from "../db/apikeys.repo.js";

export async function authenticateWs(
  url: string,
  headers: Headers,
  apiKeysRepo: ApiKeysRepo,
) {
  // Try query param first: ws://host/ws?key=ark_xxx
  const parsed = new URL(url, "http://localhost");
  let rawKey = parsed.searchParams.get("key");

  // Fall back to Authorization header: Bearer ark_xxx
  if (!rawKey) {
    const auth = headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      rawKey = auth.slice(7);
    }
  }

  if (!rawKey) {
    return null;
  }

  return apiKeysRepo.validate(rawKey);
}
