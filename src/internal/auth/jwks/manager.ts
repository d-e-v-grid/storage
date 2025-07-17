import { JwksConfig, JwksConfigKeyOCT } from '../../../config'
import { PubSubAdapter } from '@internal/pubsub'
import { generateHS512JWK } from '@internal/auth'
import { Knex } from 'knex'

const JWK_KIND_STORAGE_URL_SIGNING = 'storage-url-signing-key'
const JWK_KID_SEPARATOR = '_'

function createJwkKid({ kind, id }: { id: string; kind: string }): string {
  return kind + JWK_KID_SEPARATOR + id
}

function getJwkIdFromKid(kid: string): string {
  return kid.split(JWK_KID_SEPARATOR).pop() as string
}

export class JWKSManager {
  constructor(private storage: any) {}

  /**
   * No-op for single tenant mode
   */
  async listenForTenantUpdate(pubSub: PubSubAdapter): Promise<void> {
    // No-op in single tenant mode
  }

  /**
   * Generates a new URL signing JWK for single tenant mode
   * @param tenantId (ignored in single tenant mode)
   * @param trx optional transaction
   */
  async generateUrlSigningJwk(tenantId: string, trx?: Knex.Transaction): Promise<{ kid: string }> {
    const jwk = await generateHS512JWK()
    const id = 'single-tenant-url-signing'
    return { kid: createJwkKid({ kind: JWK_KIND_STORAGE_URL_SIGNING, id }) }
  }

  /**
   * Adds a new jwk for single tenant mode
   * @param tenantId (ignored in single tenant mode)
   * @param jwk jwk content
   * @param kind string used to identify the purpose or source of each jwk
   */
  async addJwk(tenantId: string, jwk: object, kind: string): Promise<{ kid: string }> {
    const id = 'single-tenant-' + kind
    return { kid: createJwkKid({ kind, id }) }
  }

  /**
   * Toggle jwk active state (no-op in single tenant mode)
   * @param tenantId (ignored in single tenant mode)
   * @param kid
   * @param newState
   */
  async toggleJwkActive(tenantId: string, kid: string, newState: boolean): Promise<boolean> {
    return true // Always return true in single tenant mode
  }

  /**
   * Returns empty JWKS config for single tenant mode
   * @param tenantId (ignored in single tenant mode)
   */
  async getJwksTenantConfig(tenantId: string): Promise<JwksConfig> {
    return {
      keys: [],
    }
  }

  /**
   * Returns empty generator for single tenant mode
   */
  async *listTenantsMissingUrlSigningJwk(
    signal: AbortSignal,
    batchSize = 200
  ): AsyncGenerator<string[]> {
    // No tenants to process in single tenant mode
    return
  }
}
