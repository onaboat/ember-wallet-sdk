/** Keep failure evidence useful without copying URLs, bodies, or credentials. */
export function safeConformanceError(error) {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const safe = { name: error.name };
  for (const field of ['code', 'field', 'operation', 'reason', 'status']) {
    const value = error[field];
    if (typeof value === 'string' || typeof value === 'number') {
      safe[field] = value;
    }
  }
  return safe;
}
