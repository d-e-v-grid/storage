import { getConfig, JwksConfig, JwksConfigKeyOCT } from '../../config'
import { DBMigration } from './migrations/types'
import { lastLocalMigrationName } from '@internal/database/migrations/files'

export interface Features {
  imageTransformation: {
    enabled: boolean
    maxResolution?: number
  }
  purgeCache: {
    enabled: boolean
  }
}

const {
  dbServiceRole,
  serviceKeyAsync,
  jwtSecret,
  dbMigrationFreezeAt,
  uploadFileSizeLimit,
  imageTransformationEnabled,
} = getConfig()

const singleTenantServiceKey = {
  jwt: serviceKeyAsync,
  payload: {
    role: dbServiceRole,
  },
}

export async function getServiceKeyUser(tenantId: string) {
  return {
    jwt: await singleTenantServiceKey.jwt,
    payload: singleTenantServiceKey.payload,
  }
}

/**
 * Get the service key for single tenant mode
 * @param tenantId (ignored in single tenant mode)
 */
export async function getServiceKey(tenantId: string): Promise<string> {
  return await singleTenantServiceKey.jwt
}

enum Capability {
  LIST_V2 = 'list_V2',
}

/**
 * Get the capabilities for single tenant
 * @param tenantId (ignored in single tenant mode)
 */
export async function getTenantCapabilities(tenantId: string) {
  const capabilities: Record<Capability, boolean> = {
    [Capability.LIST_V2]: false,
  }

  let latestMigrationName = dbMigrationFreezeAt || (await lastLocalMigrationName())

  if (DBMigration[latestMigrationName] >= DBMigration['optimise-existing-functions']) {
    capabilities[Capability.LIST_V2] = true
  }

  return capabilities
}

/**
 * Check if a tenant has a specific feature enabled
 * In single tenant mode, all features are enabled based on configuration
 *
 * @param tenantId (ignored in single tenant mode)
 * @param feature
 */
export async function tenantHasFeature(
  tenantId: string,
  feature: keyof Features
): Promise<boolean> {
  const features = await getFeatures(tenantId)
  return features[feature].enabled
}

/**
 * Get the jwt key for single tenant
 * @param tenantId (ignored in single tenant mode)
 */
export async function getJwtSecret(
  tenantId: string
): Promise<{ secret: string; urlSigningKey: string | JwksConfigKeyOCT; jwks: JwksConfig }> {
  const { jwtJWKS } = getConfig()
  const secret = jwtSecret
  const jwks = jwtJWKS || { keys: [] }

  const urlSigningKey = jwks.urlSigningKey || secret
  return { secret, urlSigningKey, jwks }
}

/**
 * Get the file size limit for single tenant
 * @param tenantId (ignored in single tenant mode)
 */
export async function getFileSizeLimit(tenantId: string): Promise<number> {
  return uploadFileSizeLimit
}

/**
 * Get features flags config for single tenant
 * @param tenantId (ignored in single tenant mode)
 */
export async function getFeatures(tenantId: string): Promise<Features> {
  return {
    imageTransformation: {
      enabled: imageTransformationEnabled,
    },
    purgeCache: {
      enabled: true, // always enabled in single tenant
    },
  }
}

// Legacy multi-tenant exports kept for compatibility
export enum TenantMigrationStatus {
  COMPLETED = 'completed',
  FAILED = 'failed',
  FAILED_STALE = 'failed_stale',
  PENDING = 'pending',
}

export interface TenantConfig {
  migrationVersion?: string
  migrationStatus?: TenantMigrationStatus
  syncMigrationsDone?: boolean
  databaseUrl: string
  databasePoolUrl?: string
  maxConnections?: number
  databasePoolMode?: string
}

// Single-tenant config getter for compatibility
export async function getTenantConfig(tenantId: string): Promise<TenantConfig> {
  const { databaseURL, databasePoolURL, databaseMaxConnections } = getConfig()
  const migrationVersion = await lastLocalMigrationName()

  return {
    databaseUrl: databaseURL,
    databasePoolUrl: databasePoolURL,
    maxConnections: databaseMaxConnections,
    migrationVersion,
    migrationStatus: TenantMigrationStatus.COMPLETED,
    syncMigrationsDone: true,
  }
}

// Empty functions for compatibility
export function deleteTenantConfig(tenantId: string): void {
  // No-op in single tenant mode
}

export async function listenForTenantUpdate(): Promise<void> {
  // No-op in single tenant mode
}

// Stub implementations for single-tenant mode
export const jwksManager = {
  async getJwksTenantConfig(tenantId: string) {
    return { keys: [] }
  },
  async addJwk(tenantId: string, jwk: object, kind: string) {
    return { kid: 'single-tenant-' + kind }
  },
  async toggleJwkActive(tenantId: string, kid: string, newState: boolean) {
    return true
  },
  async generateUrlSigningJwk(tenantId: string, trx?: any) {
    return { kid: 'single-tenant-url-signing' }
  },
  async listenForTenantUpdate() {
    // No-op in single tenant mode
  },
  async *listTenantsMissingUrlSigningJwk() {
    // No tenants to process in single tenant mode
    return
  },
}

