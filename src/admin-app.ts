import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import { routes, plugins, setErrorHandler } from './http'

const build = (opts: FastifyServerOptions = {}): FastifyInstance => {
  const app = fastify(opts)
  app.register(plugins.signals)
  app.register(plugins.adminTenantId)
  app.register(plugins.logRequest({ excludeUrls: ['/status', '/metrics', '/health'] }))
  app.register(routes.queue, { prefix: 'queue' })

  app.register(plugins.metrics({ enabledEndpoint: true }))

  app.get('/status', async (_, response) => response.status(200).send())

  setErrorHandler(app)

  return app
}

export default build
