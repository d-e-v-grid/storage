import fastifyPlugin from 'fastify-plugin'
import { getConfig } from '../../config'
import {
  getServiceKeyUser,
  getTenantConfig,
  TenantConnection,
  getPostgresConnection,
} from '@internal/database'
import { logSchema } from '@internal/monitoring'
import { DBMigration, lastLocalMigrationName } from '@internal/database/migrations'
import { ERRORS } from '@internal/errors'

declare module 'fastify' {
  interface FastifyRequest {
    db: TenantConnection
    latestMigration?: keyof typeof DBMigration
  }
}

export const db = fastifyPlugin(
  async function db(fastify) {
    fastify.register(migrations)

    fastify.decorateRequest('db', null)

    fastify.addHook('preHandler', async (request) => {
      const adminUser = await getServiceKeyUser(request.tenantId)
      const userPayload = request.jwtPayload

      if (!userPayload) {
        throw ERRORS.AccessDenied('JWT payload is missing')
      }

      request.db = await getPostgresConnection({
        user: {
          payload: userPayload,
          jwt: request.jwt,
        },
        superUser: adminUser,
        tenantId: request.tenantId,
        host: request.headers['x-forwarded-host'] as string,
        headers: request.headers,
        path: request.url,
        method: request.method,
        operation: () => request.operation?.type,
      })
    })

    fastify.addHook('onSend', async (request, reply, payload) => {
      if (request.db) {
        request.db.dispose().catch((e) => {
          logSchema.error(request.log, 'Error disposing db connection', {
            type: 'db-connection',
            error: e,
          })
        })
      }
      return payload
    })

    fastify.addHook('onTimeout', async (request) => {
      if (request.db) {
        request.db.dispose().catch((e) => {
          logSchema.error(request.log, 'Error disposing db connection', {
            type: 'db-connection',
            error: e,
          })
        })
      }
    })

    fastify.addHook('onRequestAbort', async (request) => {
      if (request.db) {
        request.db.dispose().catch((e) => {
          logSchema.error(request.log, 'Error disposing db connection', {
            type: 'db-connection',
            error: e,
          })
        })
      }
    })
  },
  { name: 'db-init' }
)

interface DbSuperUserPluginOptions {
  disableHostCheck?: boolean
  maxConnections?: number
}

export const dbSuperUser = fastifyPlugin<DbSuperUserPluginOptions>(
  async function dbSuperUser(fastify, opts) {
    fastify.register(migrations)
    fastify.decorateRequest('db', null)

    fastify.addHook('preHandler', async (request) => {
      const adminUser = await getServiceKeyUser(request.tenantId)

      request.db = await getPostgresConnection({
        user: adminUser,
        superUser: adminUser,
        tenantId: request.tenantId,
        host: request.headers['x-forwarded-host'] as string,
        path: request.url,
        method: request.method,
        headers: request.headers,
        disableHostCheck: opts.disableHostCheck,
        maxConnections: opts.maxConnections,
        operation: () => request.operation?.type,
      })
    })

    fastify.addHook('onSend', async (request, reply, payload) => {
      if (request.db) {
        request.db.dispose().catch((e) => {
          logSchema.error(request.log, 'Error disposing db connection', {
            type: 'db-connection',
            error: e,
          })
        })
      }

      return payload
    })

    fastify.addHook('onTimeout', async (request) => {
      if (request.db) {
        request.db.dispose().catch((e) => {
          logSchema.error(request.log, 'Error disposing db connection', {
            type: 'db-connection',
            error: e,
          })
        })
      }
    })

    fastify.addHook('onRequestAbort', async (request) => {
      if (request.db) {
        request.db.dispose().catch((e) => {
          logSchema.error(request.log, 'Error disposing db connection', {
            type: 'db-connection',
            error: e,
          })
        })
      }
    })
  },
  { name: 'db-superuser-init' }
)

/**
 * Handle database migration for single tenant applications
 */
export const migrations = fastifyPlugin(
  async function migrations(fastify) {
    fastify.addHook('preHandler', async (req) => {
      req.latestMigration = await lastLocalMigrationName()
    })
  },
  { name: 'db-migrations' }
)
