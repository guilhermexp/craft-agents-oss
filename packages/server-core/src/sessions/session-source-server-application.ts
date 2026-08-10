/**
 * Starts both independent server-application branches and does not reject until
 * both are settled. Cleanup may therefore never race a late candidate write.
 */
export async function applySourceServerBranches(
  applyBridge: () => Promise<void>,
  syncPool: () => Promise<void>,
): Promise<void> {
  const start = (branch: () => Promise<void>): Promise<void> => Promise.resolve().then(branch)
  const results = await Promise.allSettled([start(applyBridge), start(syncPool)])
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Source server application failed')
  }
}
