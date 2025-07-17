import { FastifyInstance } from 'fastify'
import { Queue } from '@internal/queue'
import { getServiceKeyUser } from '@internal/database'
import { getKnexInstance } from '@internal/database/connection'
import apiKey from '../../plugins/apikey'
import { getConfig } from '../../../config'
import { DBMigration, runMigrations } from '@internal/database/migrations'

const { pgQueueEnable } = getConfig()

export default async function routes(fastify: FastifyInstance) {
  fastify.register(apiKey)

  fastify.post('/migrate', async (req, reply) => {
    // Run migrations on single tenant database
    await runMigrations()
    return reply.send({ message: 'Migrations completed' })
  })

  // Single tenant doesn't need fleet reset
  fastify.post('/reset', async (req, reply) => {
    return reply.status(400).send({ message: 'Not supported in single tenant mode' })
  })

  fastify.get('/active', async (req, reply) => {
    if (!pgQueueEnable) {
      return reply.code(400).send({ message: 'Queue is not enabled' })
    }
    // Get connection for single tenant
    const serviceKey = await getServiceKeyUser('single-tenant')
    const knexClient = await getKnexInstance({
      searchPath: 'pgboss_v10,public',
      serviceKey: serviceKey.jwt,
    })

    try {
      const data = await knexClient
        .table('pgboss_v10.job')
        .where('state', 'active')
        .orderBy('created_on', 'desc')
        .limit(2000)

      return reply.send(data)
    } finally {
      await knexClient.destroy()
    }
  })

  fastify.delete('/active', async (req, reply) => {
    if (!pgQueueEnable) {
      return reply.code(400).send({ message: 'Queue is not enabled' })
    }
    // Get connection for single tenant
    const serviceKey = await getServiceKeyUser('single-tenant')
    const knexClient = await getKnexInstance({
      searchPath: 'pgboss_v10,public',
      serviceKey: serviceKey.jwt,
    })

    try {
      const data = await knexClient
        .table('pgboss_v10.job')
        .where('state', 'active')
        .orderBy('created_on', 'desc')
        .update({ state: 'completed' })
        .limit(2000)

      return reply.send(data)
    } finally {
      await knexClient.destroy()
    }
  })

  fastify.get('/progress', async (req, reply) => {
    // Single tenant doesn't have fleet progress
    return { remaining: 0 }
  })

  fastify.get('/failed', async (req, reply) => {
    // Single tenant doesn't have fleet failures
    reply.status(200).send({
      next_cursor_id: null,
      data: [],
    })
  })
}
