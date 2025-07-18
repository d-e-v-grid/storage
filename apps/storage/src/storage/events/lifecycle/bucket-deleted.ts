import { BaseEvent } from '../base-event'
import { BasePayload } from '@internal/queue'
import { Job } from 'pg-boss'

interface BucketDeletedEvent extends BasePayload {
  bucketId: string
}

export class BucketDeleted extends BaseEvent<BucketDeletedEvent> {
  protected static queueName = 'bucket:created'

  static eventName() {
    return `Bucket:Deleted`
  }

  static async handle(job: Job<BucketDeletedEvent>) {
    // No special handling needed for bucket deletion
    return
  }
}
