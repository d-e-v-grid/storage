import { getConfig } from '../../config'
import { knex, Knex } from 'knex'
import { logger, logSchema } from '@internal/monitoring'
import { getSslSettings } from '@internal/database/ssl'
import { JWTPayload } from 'jose'

const {
  databaseURL,
  databaseSSLRootCert,
  databaseMaxConnections,
  databaseFreePoolAfterInactivity,
  databaseConnectionTimeout,
  dbSearchPath,
  dbPostgresVersion,
} = getConfig()

export interface ConnectionOptions {
  user: User
  superUser: User
  headers?: Record<string, string | undefined | string[]>
  method?: string
  path?: string
  operation?: () => string | undefined
}

export interface User {
  jwt: string
  payload: { role?: string } & JWTPayload
}

export const searchPath = ['storage', 'public', 'extensions', ...dbSearchPath.split(',')].filter(
  Boolean
)

// Single shared pool for single-tenant mode
let sharedPool: Knex | undefined

/**
 * PoolManager manages a single Knex connection pool in single-tenant mode.
 */
export class PoolManager {
  getPool(): Knex {
    if (!sharedPool) {
      sharedPool = this.createKnexPool()
    }
    return sharedPool
  }

  async destroy(): Promise<void> {
    if (sharedPool) {
      await sharedPool.destroy()
      sharedPool = undefined
    }
  }

  monitor(signal: AbortSignal): void {
    // No-op in single tenant mode
  }

  rebalanceAll(): void {
    // No-op in single tenant mode
  }

  private createKnexPool(): Knex {
    const sslSettings = getSslSettings({
      connectionString: databaseURL,
      databaseSSLRootCert,
    })

    return knex({
      client: 'pg',
      version: dbPostgresVersion,
      searchPath: searchPath,
      pool: {
        min: 0,
        max: databaseMaxConnections,
        acquireTimeoutMillis: databaseConnectionTimeout,
        idleTimeoutMillis: databaseFreePoolAfterInactivity,
        reapIntervalMillis: 1000,
      },
      connection: {
        connectionString: databaseURL,
        connectionTimeoutMillis: databaseConnectionTimeout,
        ssl: sslSettings ? { ...sslSettings } : undefined,
      },
      acquireConnectionTimeout: databaseConnectionTimeout,
    })
  }
}
