import { logger, logSchema } from '../../monitoring'

export interface UrlSigningJwkGeneratorStatus {
  running: boolean
  sent: number
}

export class UrlSigningJwkGenerator {
  private static isRunning: boolean = false
  private static countSent: number = 0

  static getGenerationStatus(): UrlSigningJwkGeneratorStatus {
    return {
      running: UrlSigningJwkGenerator.isRunning,
      sent: UrlSigningJwkGenerator.countSent,
    }
  }

  /**
   * No-op for single tenant mode - URL signing JWKS are not needed
   */
  static async generateUrlSigningJwksOnAllTenants(signal: AbortSignal) {
    logSchema.info(logger, '[Jwks Generator] Skipping JWKS generation in single tenant mode', {
      type: 'jwk-generator',
    })
    return
  }
}
