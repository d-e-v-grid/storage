import { BaseEvent } from '../base-event'
import { Job, SendOptions, WorkOptions } from 'pg-boss'
import { HttpsAgent } from 'agentkeepalive'
import HttpAgent from 'agentkeepalive'
import axios from 'axios'
import { getConfig } from '../../../config'
import { logger, logSchema } from '@internal/monitoring'
const {
  webhookURL,
  webhookApiKey,
  webhookQueuePullInterval,
  webhookMaxConnections,
  webhookQueueMaxFreeSockets,
} = getConfig()

interface WebhookEvent {
  event: {
    $version: string
    type: string
    payload: object & { reqId?: string; bucketId: string; name: string }
    applyTime: number
  }
  sentAt: string
  tenant: {
    ref: string
    host: string
  }
}

const httpAgent = webhookURL?.startsWith('https://')
  ? {
      httpsAgent: new HttpsAgent({
        maxSockets: webhookMaxConnections,
        maxFreeSockets: webhookQueueMaxFreeSockets,
      }),
    }
  : {
      httpAgent: new HttpAgent({
        maxSockets: webhookMaxConnections,
        maxFreeSockets: webhookQueueMaxFreeSockets,
      }),
    }

const client = axios.create({
  ...httpAgent,
  timeout: 4000,
  headers: {
    ...(webhookApiKey ? { authorization: `Bearer ${webhookApiKey}` } : {}),
  },
})

export class Webhook extends BaseEvent<WebhookEvent> {
  static queueName = 'webhooks'

  static getWorkerOptions(): WorkOptions {
    return {
      pollingIntervalSeconds: webhookQueuePullInterval
        ? webhookQueuePullInterval / 1000
        : undefined,
    }
  }

  static getSendOptions(): SendOptions {
    return {
      expireInSeconds: 30,
    }
  }

  static async shouldSend(payload: WebhookEvent) {
    return true
  }

  static async handle(job: Job<WebhookEvent>) {
    if (!webhookURL) {
      logger.debug('skipping webhook, no WEBHOOK_URL set')
      return job
    }

    const payload = job.data.event.payload as { bucketId?: string; name?: string }
    const path = `${job.data.tenant.ref}/${payload.bucketId}/${payload.name}`

    logSchema.event(logger, `[Lifecycle]: ${job.data.event.type} ${path}`, {
      jodId: job.id,
      type: 'event',
      event: job.data.event.type,
      payload: JSON.stringify(job.data.event.payload),
      objectPath: path,
      resources: ['/' + path],
      tenantId: job.data.tenant.ref,
      project: job.data.tenant.ref,
      reqId: job.data.event.payload.reqId,
    })

    try {
      await client.post(webhookURL, {
        type: 'Webhook',
        event: job.data.event,
        sentAt: new Date(),
        tenant: job.data.tenant,
      })
    } catch (e) {
      logger.error(
        {
          error: (e as Error)?.message,
          jodId: job.id,
          type: 'event',
          event: job.data.event.type,
          payload: JSON.stringify(job.data.event.payload),
          objectPath: path,
          resources: [path],
          tenantId: job.data.tenant.ref,
          project: job.data.tenant.ref,
          reqId: job.data.event.payload.reqId,
        },
        `[Lifecycle]: ${job.data.event.type} ${path} - FAILED`
      )
      throw new Error(
        `Failed to send webhook for event ${job.data.event.type} to ${webhookURL}: ${
          (e as Error).message
        }`
      )
    }

    return job
  }
}
