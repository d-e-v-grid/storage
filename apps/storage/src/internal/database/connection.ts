import pg, { DatabaseError } from 'pg'
import { Knex, knex } from 'knex'
import retry from 'async-retry'
import KnexTimeoutError = knex.KnexTimeoutError
import { ERRORS } from '@internal/errors'
import { PoolManager, searchPath, ConnectionOptions } from '@internal/database/pool'

// https://github.com/knex/knex/issues/387#issuecomment-51554522
pg.types.setTypeParser(20, 'text', parseInt)

/**
 * Get a Knex instance with custom configuration
 * Useful for operations that need specific search paths or settings
 */
export async function getKnexInstance(options: {
  searchPath?: string
  serviceKey?: string
}): Promise<Knex> {
  const manager = new PoolManager()
  const pool = manager.getPool()

  // Set search path after getting the pool
  if (options.searchPath) {
    await pool.raw(`SET search_path TO ${options.searchPath}`)
  }

  return pool
}

export class TenantConnection {
  static poolManager = new PoolManager()
  public readonly role: string

  constructor(public readonly pool: Knex, protected readonly options: ConnectionOptions) {
    this.role = options.user.payload.role || 'anon'
  }

  static stop() {
    return TenantConnection.poolManager.destroy()
  }

  static async create(options: ConnectionOptions) {
    const knexPool = TenantConnection.poolManager.getPool()
    return new this(knexPool, options)
  }

  dispose() {
    // No-op in single-tenant mode as we share a single pool
    return Promise.resolve()
  }

  async transaction(instance?: Knex) {
    try {
      const tnx = await retry(
        async (bail) => {
          try {
            const pool = instance || this.pool
            return await pool.transaction()
          } catch (e) {
            if (
              e instanceof DatabaseError &&
              ((e.code === '08P01' && e.message.includes('no more connections allowed')) ||
                e.message.includes('Max client connections reached'))
            ) {
              throw e
            }

            bail(e as Error)
            return
          }
        },
        {
          minTimeout: 50,
          maxTimeout: 200,
          maxRetryTime: 3000,
          retries: 10,
        }
      )

      if (!tnx) {
        throw ERRORS.InternalError(undefined, 'Could not create transaction')
      }

      // Always set search path in single-tenant mode
      try {
        await tnx.raw(`SELECT set_config('search_path', ?, true)`, [searchPath.join(', ')])
      } catch (e) {
        await tnx.rollback()
        throw e
      }

      return tnx
    } catch (e) {
      if (e instanceof KnexTimeoutError) {
        throw ERRORS.DatabaseTimeout(e)
      }

      throw e
    }
  }

  transactionProvider(instance?: Knex): Knex.TransactionProvider {
    return async () => {
      return this.transaction(instance)
    }
  }

  asSuperUser() {
    return new TenantConnection(this.pool, {
      ...this.options,
      user: this.options.superUser,
    })
  }

  async setScope(tnx: Knex) {
    const headers = JSON.stringify(this.options.headers || {})
    await tnx.raw(
      `
        SELECT
          set_config('role', ?, true),
          set_config('request.jwt.claim.role', ?, true),
          set_config('request.jwt', ?, true),
          set_config('request.jwt.claim.sub', ?, true),
          set_config('request.jwt.claims', ?, true),
          set_config('request.headers', ?, true),
          set_config('request.method', ?, true),
          set_config('request.path', ?, true),
          set_config('storage.operation', ?, true);
    `,
      [
        this.role,
        this.role,
        this.options.user.jwt || '',
        this.options.user.payload.sub || '',
        JSON.stringify(this.options.user.payload),
        headers,
        this.options.method || '',
        this.options.path || '',
        this.options.operation?.() || '',
      ]
    )
  }
}
