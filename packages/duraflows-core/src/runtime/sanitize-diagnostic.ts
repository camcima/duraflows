/** Bounded diagnostic text safe for PostgreSQL text and JSONB, without changing application data. */
export function sanitizeDiagnostic(message: string): string {
  // The Unicode regexp consumes a valid surrogate pair as one character.
  // Any surrogate matched individually is therefore unpaired.
  const safe = message.replaceAll("\u0000", "\uFFFD").replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  let end = Math.min(safe.length, 2000);
  const last = safe.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return safe.slice(0, end);
}
