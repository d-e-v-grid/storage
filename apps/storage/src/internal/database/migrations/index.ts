export * from './migrate'
export * from './files'
export * from './types'
export * from './progressive'

// Additional exports for compatibility
export async function tenantHasMigrations(tenantId: string): Promise<boolean> {
  // In single tenant mode, always return true
  return true
}

export async function resetMigration(tenantId: string): Promise<void> {
  // No-op in single tenant mode
}
