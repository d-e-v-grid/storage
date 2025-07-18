import { PostgresPubSub } from '../pubsub'
import { getConfig } from '../../config'
import { logger } from '../monitoring'

const { databaseURL } = getConfig()

export const PubSub = new PostgresPubSub(databaseURL)

PubSub.on('error', (err) => {
  logger.error('PubSub error', {
    type: 'pubsub',
    error: err,
  })
})
