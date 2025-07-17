import { getConfig } from '../../config'
import { TenantConnection } from './connection'
import { User } from './pool'
import { ERRORS } from '@internal/errors'

export interface ConnectionOptions {
  headers?: Record<string, string | undefined | string[]>
  method?: string
  path?: string
  user: User
  superUser: User
  operation?: () => string | undefined
  tenantId?: string
  host?: string
  disableHostCheck?: boolean
  maxConnections?: number
}

/**
 * Creates a database connection for single-tenant mode
 * @param options
 */
export async function getPostgresConnection(options: ConnectionOptions): Promise<TenantConnection> {
  return await TenantConnection.create(options)
}
