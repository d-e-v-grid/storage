import { BaseEvent } from '../base-event'
import { BasePayload } from '@internal/queue'
import { Job } from 'pg-boss'

interface ObjectCreatedEvent extends BasePayload {
  bucketId: string
}

export class BucketCreatedEvent extends BaseEvent<ObjectCreatedEvent> {
  protected static queueName = 'bucket:created'

  static eventName() {
    return `Bucket:Created`
  }

  static async handle(job: Job<ObjectCreatedEvent>) {
    // In single-tenant mode, we don't need to handle analytics bucket creation
    return
  }
}
