import dotenv from 'dotenv'
import type { DBMigration } from '@internal/database/migrations'
import { SignJWT } from 'jose'

export type StorageBackendType = 'file' | 's3'

export interface JwksConfigKeyBase {
  kid?: string
  kty: string
  alg?: string
}

export interface JwksConfigKeyOCT extends JwksConfigKeyBase {
  k: string
  kty: 'oct'
}

export interface JwksConfigKeyRSA extends JwksConfigKeyBase {
  k: string
  kty: 'RSA'
  n: string
  e: string
}

export interface JwksConfigKeyEC extends JwksConfigKeyBase {
  k: string
  kty: 'EC'
  crv: string
  x: string
  y: string
}

export interface JwksConfigKeyOKP extends JwksConfigKeyBase {
  k: string
  kty: 'OKP'
  crv: string
  x: string
}

export type JwksConfigKey = JwksConfigKeyOCT | JwksConfigKeyRSA | JwksConfigKeyEC | JwksConfigKeyOKP

export interface JwksConfig {
  keys: JwksConfigKey[]
  urlSigningKey?: JwksConfigKeyOCT
}

type StorageConfigType = {
  isProduction: boolean
  version: string
  exposeDocs: boolean
  keepAliveTimeout: number
  headersTimeout: number
  adminApiKeys: string
  adminRequestIdHeader?: string
  encryptionKey: string
  uploadFileSizeLimit: number
  uploadFileSizeLimitStandard?: number
  storageFilePath?: string
  storageFileEtagAlgorithm: 'mtime' | 'md5'
  storageS3MaxSockets: number
  storageS3Bucket: string
  storageS3Endpoint?: string
  storageS3ForcePathStyle?: boolean
  storageS3Region: string
  storageS3ClientTimeout: number
  tenantId: string
  jwtSecret: string
  jwtAlgorithm: string
  jwtCachingEnabled: boolean
  jwtJWKS?: JwksConfig
  dbAnonRole: string
  dbAuthenticatedRole: string
  dbServiceRole: string
  dbInstallRoles: boolean
  dbRefreshMigrationHashesOnMismatch: boolean
  dbSuperUser: string
  dbSearchPath: string
  dbMigrationStrategy: string
  dbMigrationFreezeAt?: keyof typeof DBMigration
  dbPostgresVersion?: string
  databaseURL: string
  databaseSSLRootCert?: string
  databasePoolURL?: string
  databasePoolMode?: 'single_use' | 'recycle'
  databaseMaxConnections: number
  databaseFreePoolAfterInactivity: number
  databaseConnectionTimeout: number
  region: string
  requestTraceHeader?: string
  requestEtagHeaders: string[]
  responseSMaxAge: number
  anonKeyAsync: Promise<string>
  serviceKeyAsync: Promise<string>
  storageBackendType: StorageBackendType
  requestUrlLengthLimit: number
  requestAllowXForwardedPrefix?: boolean
  logLevel?: string
  logflareEnabled?: boolean
  logflareApiKey?: string
  logflareSourceToken?: string
  logflareBatchSize: number
  pgQueueEnable: boolean
  pgQueueEnableWorkers?: boolean
  pgQueueReadWriteTimeout: number
  pgQueueMaxConnections: number
  pgQueueConnectionURL?: string
  pgQueueDeleteAfterHours?: number
  pgQueueDeleteAfterDays?: number
  pgQueueArchiveCompletedAfterSeconds?: number
  pgQueueRetentionDays?: number
  pgQueueConcurrentTasksPerQueue: number
  webhookURL?: string
  webhookApiKey?: string
  webhookQueuePullInterval?: number
  webhookQueueTeamSize?: number
  webhookQueueConcurrency?: number
  webhookMaxConnections: number
  webhookQueueMaxFreeSockets: number
  adminDeleteQueueTeamSize?: number
  adminDeleteConcurrency?: number
  imageTransformationEnabled: boolean
  imgProxyURL?: string
  imgProxyRequestTimeout: number
  imgProxyHttpMaxSockets: number
  imgProxyHttpKeepAlive: number
  imgLimits: {
    size: {
      min: number
      max: number
    }
  }
  postgrestForwardHeaders?: string
  adminPort: number
  port: number
  host: string
  rateLimiterEnabled: boolean
  rateLimiterDriver: 'memory' | 'redis' | string
  rateLimiterRedisUrl?: string
  rateLimiterSkipOnError?: boolean
  rateLimiterRenderPathMaxReqSec: number
  rateLimiterRedisConnectTimeout: number
  rateLimiterRedisCommandTimeout: number
  uploadSignedUrlExpirationTime: number
  defaultMetricsEnabled: boolean
  tracingEnabled?: boolean
  tracingMode?: string
  tracingTimeMinDuration: number
  tracingReturnServerTimings: boolean
  tracingFeatures?: {
    upload: boolean
  }
}

/**
 * Safely parses an integer with validation
 */
function parseIntSafe(
  value: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  const parsed = parseInt(value || '', 10)
  if (isNaN(parsed)) return defaultValue
  if (min !== undefined && parsed < min) {
    throw new Error(`Value ${parsed} is below minimum ${min}`)
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`Value ${parsed} is above maximum ${max}`)
  }
  return parsed
}

/**
 * Validates that a URL has the correct format
 */
function validateUrl(url: string, allowedProtocols: string[] = ['http:', 'https:']): boolean {
  try {
    const parsedUrl = new URL(url)
    return allowedProtocols.includes(parsedUrl.protocol)
  } catch {
    return false
  }
}

/**
 * Validates storage backend type
 */
function validateStorageBackendType(value: string | undefined): StorageBackendType {
  const validTypes: StorageBackendType[] = ['file', 's3']
  if (value && !validTypes.includes(value as StorageBackendType)) {
    throw new Error(`Invalid STORAGE_BACKEND: ${value}. Must be one of: ${validTypes.join(', ')}`)
  }
  return (value || 'file') as StorageBackendType
}

function getOptionalConfigFromEnv(key: string, fallback?: string): string | undefined {
  const envValue = process.env[key]

  if (!envValue && fallback) {
    return getOptionalConfigFromEnv(fallback)
  }

  return envValue
}

function getConfigFromEnv(key: string, fallbackEnv?: string): string {
  const value = getOptionalConfigFromEnv(key)
  if (!value) {
    if (fallbackEnv) {
      return getConfigFromEnv(fallbackEnv)
    }

    throw new Error(`${key} is undefined`)
  }
  return value
}

let config: StorageConfigType | undefined
let envPaths = ['.env']

export function setEnvPaths(paths: string[]) {
  envPaths = paths
}

export function mergeConfig(newConfig: Partial<StorageConfigType>) {
  config = { ...config, ...(newConfig as Required<StorageConfigType>) }
}

export function getConfig(options?: { reload?: boolean }): StorageConfigType {
  if (config && !options?.reload) {
    return config
  }

  envPaths.map((envPath) => dotenv.config({ path: envPath, override: false }))

  config = {
    isProduction: process.env.NODE_ENV === 'production',
    exposeDocs: getOptionalConfigFromEnv('EXPOSE_DOCS') !== 'false',

    // Server
    region: getOptionalConfigFromEnv('SERVER_REGION', 'REGION') || 'not-specified',
    version: getOptionalConfigFromEnv('VERSION') || '0.0.0',
    keepAliveTimeout: parseIntSafe(
      getOptionalConfigFromEnv('SERVER_KEEP_ALIVE_TIMEOUT'),
      61,
      0,
      300
    ),
    headersTimeout: parseIntSafe(getOptionalConfigFromEnv('SERVER_HEADERS_TIMEOUT'), 65, 0, 300),
    host: getOptionalConfigFromEnv('SERVER_HOST', 'HOST') || '0.0.0.0',
    port: Number(getOptionalConfigFromEnv('SERVER_PORT', 'PORT')) || 5000,
    adminPort: Number(getOptionalConfigFromEnv('SERVER_ADMIN_PORT', 'ADMIN_PORT')) || 5001,

    // Request
    requestAllowXForwardedPrefix:
      getOptionalConfigFromEnv('REQUEST_ALLOW_X_FORWARDED_PATH') === 'true',
    requestUrlLengthLimit:
      Number(getOptionalConfigFromEnv('REQUEST_URL_LENGTH_LIMIT', 'URL_LENGTH_LIMIT')) || 7_500,

    // Tenant
    tenantId:
      getOptionalConfigFromEnv('PROJECT_REF') ||
      getOptionalConfigFromEnv('TENANT_ID') ||
      'storage-single-tenant',
    requestTraceHeader: getOptionalConfigFromEnv('REQUEST_TRACE_HEADER', 'REQUEST_ID_HEADER'),
    requestEtagHeaders: getOptionalConfigFromEnv('REQUEST_ETAG_HEADERS')?.trim().split(',') || [
      'if-none-match',
    ],
    responseSMaxAge: parseIntSafe(getOptionalConfigFromEnv('RESPONSE_S_MAXAGE'), 0, 0),

    // Admin
    adminApiKeys: getOptionalConfigFromEnv('SERVER_ADMIN_API_KEYS', 'ADMIN_API_KEYS') || '',
    adminRequestIdHeader: getOptionalConfigFromEnv(
      'REQUEST_TRACE_HEADER',
      'REQUEST_ADMIN_TRACE_HEADER'
    ),

    encryptionKey: (() => {
      const key = getOptionalConfigFromEnv('AUTH_ENCRYPTION_KEY', 'ENCRYPTION_KEY')
      const isProduction = process.env.NODE_ENV === 'production'
      if (!key && isProduction) {
        throw new Error('AUTH_ENCRYPTION_KEY is required in production')
      }
      return key || 'dev-only-encryption-key-change-in-production'
    })(),
    jwtSecret: (() => {
      const secret = getConfigFromEnv('AUTH_JWT_SECRET', 'PGRST_JWT_SECRET')
      const isProduction = process.env.NODE_ENV === 'production'
      if (isProduction && secret.length < 32) {
        throw new Error('JWT secret must be at least 32 characters in production')
      }
      return secret
    })(),
    jwtAlgorithm: getOptionalConfigFromEnv('AUTH_JWT_ALGORITHM', 'PGRST_JWT_ALGORITHM') || 'HS256',
    jwtCachingEnabled: getOptionalConfigFromEnv('JWT_CACHING_ENABLED') === 'true',

    // Upload
    uploadFileSizeLimit: Number(
      getOptionalConfigFromEnv('UPLOAD_FILE_SIZE_LIMIT', 'FILE_SIZE_LIMIT')
    ),
    uploadFileSizeLimitStandard: parseIntSafe(
      getOptionalConfigFromEnv(
        'UPLOAD_FILE_SIZE_LIMIT_STANDARD',
        'FILE_SIZE_LIMIT_STANDARD_UPLOAD'
      ),
      0,
      0
    ),
    uploadSignedUrlExpirationTime: parseIntSafe(
      getOptionalConfigFromEnv(
        'UPLOAD_SIGNED_URL_EXPIRATION_TIME',
        'SIGNED_UPLOAD_URL_EXPIRATION_TIME'
      ),
      60,
      1,
      86400
    ),

    // Storage
    storageBackendType: validateStorageBackendType(getOptionalConfigFromEnv('STORAGE_BACKEND')),

    // Storage - File
    storageFilePath: getOptionalConfigFromEnv(
      'STORAGE_FILE_BACKEND_PATH',
      'FILE_STORAGE_BACKEND_PATH'
    ),
    storageFileEtagAlgorithm: getOptionalConfigFromEnv('STORAGE_FILE_ETAG_ALGORITHM') || 'md5',

    // Storage - S3
    storageS3MaxSockets: parseIntSafe(
      getOptionalConfigFromEnv('STORAGE_S3_MAX_SOCKETS', 'GLOBAL_S3_MAX_SOCKETS'),
      200,
      1,
      10000
    ),
    storageS3Bucket: getOptionalConfigFromEnv('STORAGE_S3_BUCKET', 'GLOBAL_S3_BUCKET'),
    storageS3Endpoint: getOptionalConfigFromEnv('STORAGE_S3_ENDPOINT', 'GLOBAL_S3_ENDPOINT'),
    storageS3ForcePathStyle:
      getOptionalConfigFromEnv('STORAGE_S3_FORCE_PATH_STYLE', 'GLOBAL_S3_FORCE_PATH_STYLE') ===
      'true',
    storageS3Region: getOptionalConfigFromEnv('STORAGE_S3_REGION', 'REGION') as string,
    storageS3ClientTimeout: Number(getOptionalConfigFromEnv('STORAGE_S3_CLIENT_TIMEOUT') || `0`),

    // DB - Migrations
    dbAnonRole: getOptionalConfigFromEnv('DB_ANON_ROLE') || 'anon',
    dbServiceRole: getOptionalConfigFromEnv('DB_SERVICE_ROLE') || 'service_role',
    dbAuthenticatedRole: getOptionalConfigFromEnv('DB_AUTHENTICATED_ROLE') || 'authenticated',
    dbInstallRoles: getOptionalConfigFromEnv('DB_INSTALL_ROLES') === 'true',
    dbRefreshMigrationHashesOnMismatch: !(
      getOptionalConfigFromEnv('DB_ALLOW_MIGRATION_REFRESH') === 'false'
    ),
    dbSuperUser: getOptionalConfigFromEnv('DB_SUPER_USER') || 'postgres',
    dbMigrationStrategy: getOptionalConfigFromEnv('DB_MIGRATIONS_STRATEGY') || 'on_request',
    dbMigrationFreezeAt: getOptionalConfigFromEnv('DB_MIGRATIONS_FREEZE_AT') as
      | keyof typeof DBMigration
      | undefined,

    // Database - Connection
    dbSearchPath: getOptionalConfigFromEnv('DATABASE_SEARCH_PATH', 'DB_SEARCH_PATH') || '',
    dbPostgresVersion: getOptionalConfigFromEnv('DATABASE_POSTGRES_VERSION'),
    databaseSSLRootCert: getOptionalConfigFromEnv('DATABASE_SSL_ROOT_CERT'),
    databaseURL: (() => {
      const url = getConfigFromEnv('DATABASE_URL')
      if (!validateUrl(url, ['postgresql:', 'postgres:'])) {
        throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
      }
      return url
    })(),
    databasePoolURL: getOptionalConfigFromEnv('DATABASE_POOL_URL') || '',
    databasePoolMode: getOptionalConfigFromEnv('DATABASE_POOL_MODE'),
    databaseMaxConnections: parseIntSafe(
      getOptionalConfigFromEnv('DATABASE_MAX_CONNECTIONS'),
      20,
      1,
      100
    ),
    databaseFreePoolAfterInactivity: parseIntSafe(
      getOptionalConfigFromEnv('DATABASE_FREE_POOL_AFTER_INACTIVITY'),
      1000 * 60,
      0
    ),
    databaseConnectionTimeout: parseIntSafe(
      getOptionalConfigFromEnv('DATABASE_CONNECTION_TIMEOUT'),
      3000,
      0
    ),

    // Monitoring
    logLevel: getOptionalConfigFromEnv('LOG_LEVEL') || 'info',
    logflareEnabled: getOptionalConfigFromEnv('LOGFLARE_ENABLED') === 'true',
    logflareApiKey: getOptionalConfigFromEnv('LOGFLARE_API_KEY'),
    logflareSourceToken: getOptionalConfigFromEnv('LOGFLARE_SOURCE_TOKEN'),
    logflareBatchSize: parseIntSafe(getOptionalConfigFromEnv('LOGFLARE_BATCH_SIZE'), 200, 1, 10000),
    defaultMetricsEnabled: !(
      getOptionalConfigFromEnv('DEFAULT_METRICS_ENABLED', 'ENABLE_DEFAULT_METRICS') === 'false'
    ),
    tracingEnabled: getOptionalConfigFromEnv('TRACING_ENABLED') === 'true',
    tracingMode: getOptionalConfigFromEnv('TRACING_MODE') ?? 'basic',
    tracingTimeMinDuration: parseFloat(
      getOptionalConfigFromEnv('TRACING_SERVER_TIME_MIN_DURATION') ?? '100.0'
    ),
    tracingReturnServerTimings:
      getOptionalConfigFromEnv('TRACING_RETURN_SERVER_TIMINGS') === 'true',
    tracingFeatures: {
      upload: getOptionalConfigFromEnv('TRACING_FEATURE_UPLOAD') === 'true',
    },

    // Queue
    pgQueueEnable: getOptionalConfigFromEnv('PG_QUEUE_ENABLE', 'ENABLE_QUEUE_EVENTS') === 'true',
    pgQueueEnableWorkers: getOptionalConfigFromEnv('PG_QUEUE_WORKERS_ENABLE') !== 'false',
    pgQueueReadWriteTimeout: Number(getOptionalConfigFromEnv('PG_QUEUE_READ_WRITE_TIMEOUT')) || 0,
    pgQueueMaxConnections: Number(getOptionalConfigFromEnv('PG_QUEUE_MAX_CONNECTIONS')) || 4,
    pgQueueConnectionURL: getOptionalConfigFromEnv('PG_QUEUE_CONNECTION_URL'),
    pgQueueDeleteAfterDays: parseIntSafe(
      getOptionalConfigFromEnv('PG_QUEUE_DELETE_AFTER_DAYS'),
      2,
      1,
      365
    ),
    pgQueueDeleteAfterHours:
      Number(getOptionalConfigFromEnv('PG_QUEUE_DELETE_AFTER_HOURS')) || undefined,
    pgQueueArchiveCompletedAfterSeconds: parseIntSafe(
      getOptionalConfigFromEnv('PG_QUEUE_ARCHIVE_COMPLETED_AFTER_SECONDS'),
      7200,
      0
    ),
    pgQueueRetentionDays: parseIntSafe(
      getOptionalConfigFromEnv('PG_QUEUE_RETENTION_DAYS'),
      2,
      1,
      365
    ),
    pgQueueConcurrentTasksPerQueue: parseIntSafe(
      getOptionalConfigFromEnv('PG_QUEUE_CONCURRENT_TASKS_PER_QUEUE'),
      50,
      1,
      1000
    ),

    // Webhooks
    webhookURL: getOptionalConfigFromEnv('WEBHOOK_URL'),
    webhookApiKey: getOptionalConfigFromEnv('WEBHOOK_API_KEY'),
    webhookQueuePullInterval: parseIntSafe(
      getOptionalConfigFromEnv('WEBHOOK_QUEUE_PULL_INTERVAL'),
      700,
      100,
      10000
    ),
    webhookQueueTeamSize: parseIntSafe(
      getOptionalConfigFromEnv('QUEUE_WEBHOOKS_TEAM_SIZE'),
      50,
      1,
      1000
    ),
    webhookQueueConcurrency: parseIntSafe(
      getOptionalConfigFromEnv('QUEUE_WEBHOOK_CONCURRENCY'),
      5,
      1,
      100
    ),
    webhookMaxConnections: parseIntSafe(
      getOptionalConfigFromEnv('QUEUE_WEBHOOK_MAX_CONNECTIONS'),
      500,
      1,
      10000
    ),
    webhookQueueMaxFreeSockets: parseIntSafe(
      getOptionalConfigFromEnv('QUEUE_WEBHOOK_MAX_FREE_SOCKETS'),
      20,
      1,
      1000
    ),
    adminDeleteQueueTeamSize: parseIntSafe(
      getOptionalConfigFromEnv('QUEUE_ADMIN_DELETE_TEAM_SIZE'),
      50,
      1,
      1000
    ),
    adminDeleteConcurrency: parseIntSafe(
      getOptionalConfigFromEnv('QUEUE_ADMIN_DELETE_CONCURRENCY'),
      5,
      1,
      100
    ),

    // Image Transformation
    imageTransformationEnabled:
      getOptionalConfigFromEnv('IMAGE_TRANSFORMATION_ENABLED', 'ENABLE_IMAGE_TRANSFORMATION') ===
      'true',
    imgProxyRequestTimeout: parseIntSafe(
      getOptionalConfigFromEnv('IMGPROXY_REQUEST_TIMEOUT'),
      15,
      1,
      300
    ),
    imgProxyHttpMaxSockets: parseIntSafe(
      getOptionalConfigFromEnv('IMGPROXY_HTTP_MAX_SOCKETS'),
      5000,
      1,
      50000
    ),
    imgProxyHttpKeepAlive: parseIntSafe(
      getOptionalConfigFromEnv('IMGPROXY_HTTP_KEEP_ALIVE_TIMEOUT'),
      61,
      0,
      300
    ),
    imgProxyURL: getOptionalConfigFromEnv('IMGPROXY_URL'),
    imgLimits: {
      size: {
        min: parseIntSafe(
          getOptionalConfigFromEnv('IMAGE_TRANSFORMATION_LIMIT_MIN_SIZE', 'IMG_LIMITS_MIN_SIZE'),
          1,
          1,
          10000
        ),
        max: parseIntSafe(
          getOptionalConfigFromEnv('IMAGE_TRANSFORMATION_LIMIT_MAX_SIZE', 'IMG_LIMITS_MAX_SIZE'),
          2000,
          1,
          50000
        ),
      },
    },

    // Rate Limiting
    rateLimiterEnabled:
      getOptionalConfigFromEnv('RATE_LIMITER_ENABLED', 'ENABLE_RATE_LIMITER') === 'true',
    rateLimiterSkipOnError: getOptionalConfigFromEnv('RATE_LIMITER_SKIP_ON_ERROR') === 'true',
    rateLimiterDriver: getOptionalConfigFromEnv('RATE_LIMITER_DRIVER') || 'memory',
    rateLimiterRedisUrl: getOptionalConfigFromEnv('RATE_LIMITER_REDIS_URL'),
    rateLimiterRenderPathMaxReqSec: parseIntSafe(
      getOptionalConfigFromEnv('RATE_LIMITER_RENDER_PATH_MAX_REQ_SEC'),
      5,
      1,
      1000
    ),
    rateLimiterRedisConnectTimeout: parseIntSafe(
      getOptionalConfigFromEnv('RATE_LIMITER_REDIS_CONNECT_TIMEOUT'),
      2,
      1,
      60
    ),
    rateLimiterRedisCommandTimeout: parseIntSafe(
      getOptionalConfigFromEnv('RATE_LIMITER_REDIS_COMMAND_TIMEOUT'),
      2,
      1,
      60
    ),
  } as StorageConfigType

  const serviceKey = getOptionalConfigFromEnv('SERVICE_KEY') || ''
  if (!serviceKey) {
    config.serviceKeyAsync = new SignJWT({ role: config.dbServiceRole })
      .setIssuedAt()
      .setExpirationTime('10y')
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(config.jwtSecret))
  } else {
    config.serviceKeyAsync = Promise.resolve(serviceKey)
  }

  const anonKey = getOptionalConfigFromEnv('ANON_KEY') || ''
  if (!anonKey) {
    config.anonKeyAsync = new SignJWT({ role: config.dbAnonRole })
      .setIssuedAt()
      .setExpirationTime('10y')
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(config.jwtSecret))
  } else {
    config.anonKeyAsync = Promise.resolve(anonKey)
  }

  const jwtJWKS = getOptionalConfigFromEnv('JWT_JWKS') || null

  if (jwtJWKS) {
    try {
      config.jwtJWKS = JSON.parse(jwtJWKS)
    } catch {
      throw new Error('Unable to parse JWT_JWKS value to JSON')
    }
  }

  return config
}
