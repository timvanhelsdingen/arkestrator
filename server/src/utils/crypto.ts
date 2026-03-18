/**
 * Generate a cryptographically random hex string.
 * @param byteLength Number of random bytes (output will be 2x this length in hex chars)
 */
export function generateRandomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
