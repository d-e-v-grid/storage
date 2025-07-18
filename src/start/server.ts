import '@internal/monitoring/otel'
import { FastifyInstance } from 'fastify'
import { IncomingMessage, Server, ServerResponse } from 'node:http'

import build from '../app'
import { getConfig } from '../config'
import { PubSub, TenantConnection } from '@internal/database'
import { logger, logSchema } from '@internal/monitoring'
import { Queue } from '@internal/queue'
import { registerWorkers } from '@storage/events'
import { AsyncAbortController } from '@internal/concurrency'

import { bindShutdownSignals, createServerClosedPromise, shutdown } from './shutdown'
import { runMigrationsOnTenant } from '@internal/database/migrations'
import { Cluster } from '@internal/cluster/cluster'

const shutdownSignal = new AsyncAbortController()

bindShutdownSignals(shutdownSignal)

// Start API server
main()
  .then(() => {
    logSchema.info(logger, '[Server] Started Successfully', {
      type: 'server',
    })
  })
  .catch(async (e) => {
    logSchema.error(logger, 'Server not started with error', {
      type: 'startupError',
      error: e,
    })

    await shutdown(shutdownSignal)
    process.exit(1)
  })
  .catch(() => {
    process.exit(1)
  })

/**
 * Start Storage API server
 */
async function main() {
  const { databaseURL, pgQueueEnable, dbMigrationFreezeAt } = getConfig()

  // Migrations
  await runMigrationsOnTenant('storage-single-tenant', {
    upToMigration: dbMigrationFreezeAt,
  })

  // Queue
  if (pgQueueEnable) {
    await Queue.start({
      signal: shutdownSignal.nextGroup.signal,
      registerWorkers: registerWorkers,
    })

    logSchema.info(logger, '[Queue] Started', {
      type: 'queue',
    })
  }

  // Pubsub
  await PubSub.start({
    signal: shutdownSignal.nextGroup.signal,
  })

  // PoolManager Monitoring
  TenantConnection.poolManager.monitor(shutdownSignal.nextGroup.signal)

  // Cluster information
  await Cluster.init(shutdownSignal.nextGroup.signal)

  Cluster.on('change', (data) => {
    logger.info(`[Cluster] Cluster size changed to ${data.size}`, {
      type: 'cluster',
      clusterSize: data.size,
    })
    TenantConnection.poolManager.rebalanceAll()
  })

  // HTTP Server
  const app = await httpServer(shutdownSignal.signal)
}

/**
 * Starts HTTP API Server
 * @param signal
 */
async function httpServer(signal: AbortSignal) {
  const { exposeDocs, requestTraceHeader, port, host } = getConfig()

  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = build({
    logger,
    disableRequestLogging: true,
    exposeDocs,
    requestIdHeader: requestTraceHeader,
    maxParamLength: 2500,
  })

  const closePromise = createServerClosedPromise(app.server, () => {
    logSchema.info(logger, '[Server] Exited', {
      type: 'server',
    })
  })

  try {
    signal.addEventListener(
      'abort',
      async () => {
        logSchema.info(logger, '[Server] Stopping', {
          type: 'server',
        })

        await closePromise
      },
      { once: true }
    )
    await app.listen({ port, host, signal })

    return app
  } catch (err) {
    logSchema.error(logger, `Server failed to start`, {
      type: 'serverStartError',
      error: err,
    })
    throw err
  }
}
