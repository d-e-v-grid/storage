import fastifyPlugin from 'fastify-plugin'
import { getConfig } from '../../config'

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string
  }
}

const { version } = getConfig()

// In single tenant mode, we use a fixed tenant ID
const DEFAULT_TENANT_ID = 'storage-single-tenant'

export const tenantId = fastifyPlugin(
  async (fastify) => {
    fastify.decorateRequest('tenantId', DEFAULT_TENANT_ID)

    fastify.addHook('onRequest', async (request, reply) => {
      // Set tenant ID to fixed value in single tenant mode
      request.tenantId = DEFAULT_TENANT_ID

      reply.log = request.log = request.log.child({
        tenantId: request.tenantId,
        project: request.tenantId,
        reqId: request.id,
        appVersion: version,
      })
    })
  },
  { name: 'tenant-id' }
)

export const adminTenantId = fastifyPlugin(
  async (fastify) => {
    fastify.addHook('onRequest', async (request, reply) => {
      // In single tenant mode, always use the default tenant ID
      request.tenantId = DEFAULT_TENANT_ID

      reply.log = request.log = request.log.child({
        tenantId: request.tenantId,
        project: request.tenantId,
        reqId: request.id,
      })
    })
  },
  { name: 'admin-tenant-id' }
)
