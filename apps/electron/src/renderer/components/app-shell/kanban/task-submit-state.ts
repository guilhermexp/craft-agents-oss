/** Reuse a task already created by a previous create-and-run attempt. */
export async function ensureCreatedTask<T>(
  existing: T | null,
  create: () => Promise<T>,
): Promise<T> {
  return existing ?? create()
}
