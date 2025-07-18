import { Client, ClientConfig } from 'pg'
import SQL from 'sql-template-strings'
import { MigrationError } from 'postgres-migrations'
import { getConfig } from '../../../config'
import { logger, logSchema } from '../../monitoring'
import { BasicPgClient, Migration } from 'postgres-migrations/dist/types'
import { validateMigrationHashes } from 'postgres-migrations/dist/validation'
import { runMigration } from 'postgres-migrations/dist/run-migration'
import { searchPath } from '../pool'
import { ERRORS } from '@internal/errors'
import { DBMigration } from './types'
import { getSslSettings } from '../ssl'
import { MigrationTransformer, DisableConcurrentIndexTransformer } from './transformers'
import { loadMigrationFilesCached, localMigrationFiles, lastLocalMigrationName } from './files'

const {
  databaseURL,
  databaseSSLRootCert,
  dbAnonRole,
  dbAuthenticatedRole,
  dbSuperUser,
  dbServiceRole,
  dbInstallRoles,
  dbRefreshMigrationHashesOnMismatch,
  dbMigrationFreezeAt,
} = getConfig()

/**
 * Migrations that were added after the initial release
 */
const backportMigrations = [
  {
    index: 2,
    from: 'pathtoken-column',
    to: 'storage-schema',
  },
]

export async function hasMigration(migration: keyof typeof DBMigration) {
  const migrationVersion = await lastLocalMigrationName()

  if (migrationVersion) {
    return DBMigration[migrationVersion] >= DBMigration[migration]
  }
  return false
}

/**
 * Check if migrations are up to date for a tenant
 * In single tenant mode, this always returns true since migrations are run on startup
 * @param tenantId (ignored in single tenant mode)
 */
export async function areMigrationsUpToDate(tenantId: string): Promise<boolean> {
  // In single tenant mode, migrations are always up to date
  // as they are run on startup
  return true
}

/**
 * Run migrations on a specific tenant
 * In single tenant mode, this just runs the regular migrations
 * @param tenantId (ignored in single tenant mode)
 * @param options
 */
export async function runMigrationsOnTenant(
  tenantId: string,
  options?: { upToMigration?: keyof typeof DBMigration }
): Promise<void> {
  // In single tenant mode, just run regular migrations
  return runMigrations(options)
}

/**
 * Update tenant migration state
 * In single tenant mode, this is a no-op as there's no tenant state to update
 * @param tenantId (ignored in single tenant mode)
 * @param state
 */
export async function updateTenantMigrationsState(
  tenantId: string,
  state: { status: string; error?: string }
): Promise<void> {
  // No-op in single tenant mode
  return
}

/**
 * Runs migrations on the database
 * @param options
 */
export async function runMigrations(options?: {
  waitForLock?: boolean
  upToMigration?: keyof typeof DBMigration
}): Promise<void> {
  const waitForLock = options?.waitForLock ?? true

  await connectAndMigrate({
    databaseUrl: databaseURL,
    migrationsDirectory: './migrations',
    ssl: getSslSettings({ connectionString: databaseURL, databaseSSLRootCert }),
    shouldCreateStorageSchema: true,
    waitForLock,
    upToMigration: options?.upToMigration,
  })
}

/**
 * Connect to the database
 * @param options
 */
async function connect(options: {
  connectionString?: string | undefined
  ssl?: ClientConfig['ssl']
}) {
  const { ssl, connectionString } = options

  const dbConfig: ClientConfig = {
    connectionString: connectionString,
    connectionTimeoutMillis: 60_000,
    options: `-c search_path=${searchPath}`,
    ssl,
  }

  const client = new Client(dbConfig)
  client.on('error', (err) => {
    logSchema.error(logger, 'Error on database connection', {
      type: 'error',
      error: err,
    })
  })
  await client.connect()
  return client
}

/**
 * Connect and migrate the database
 * @param options
 */
async function connectAndMigrate(options: {
  databaseUrl: string | undefined
  migrationsDirectory: string
  ssl?: ClientConfig['ssl']
  shouldCreateStorageSchema?: boolean
  waitForLock?: boolean
  upToMigration?: keyof typeof DBMigration
}) {
  const { shouldCreateStorageSchema, migrationsDirectory, ssl, databaseUrl, waitForLock } = options

  const dbConfig: ClientConfig = {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 60_000,
    options: `-c search_path=${searchPath}`,
    statement_timeout: 1000 * 60 * 60 * 12, // 12 hours
    ssl,
  }

  const client = await connect(dbConfig)

  try {
    await client.query(`SET statement_timeout TO '12h'`)
    await migrate({
      client,
      migrationsDirectory,
      waitForLock: Boolean(waitForLock),
      shouldCreateStorageSchema,
      upToMigration: options.upToMigration,
    })
  } finally {
    await client.end()
  }
}

interface MigrateOptions {
  client: BasicPgClient
  migrationsDirectory: string
  waitForLock: boolean
  shouldCreateStorageSchema?: boolean
  upToMigration?: keyof typeof DBMigration
}

/**
 * Migration runner with advisory lock
 * @param dbConfig
 * @param migrationsDirectory
 * @param waitForLock
 * @param shouldCreateStorageSchema
 */
export async function migrate({
  client,
  migrationsDirectory,
  waitForLock,
  shouldCreateStorageSchema,
  upToMigration,
}: MigrateOptions): Promise<Array<Migration>> {
  const accessMethod = await getDefaultAccessMethod(client)
  return withAdvisoryLock(
    waitForLock,
    runMigrationsWithOptions({
      migrationsDirectory,
      shouldCreateStorageSchema,
      upToMigration,
      // Remove concurrent index creation if we're using oriole db as it does not support it currently
      transformers: accessMethod === 'orioledb' ? [new DisableConcurrentIndexTransformer()] : [],
    })
  )(client)
}

interface RunMigrationOptions {
  migrationsDirectory: string
  shouldCreateStorageSchema?: boolean
  upToMigration?: keyof typeof DBMigration
  transformers?: MigrationTransformer[]
}

/**
 * Run Migration from a specific directory
 * @param migrationsDirectory
 * @param shouldCreateStorageSchema
 * @param upToMigration
 */
function runMigrationsWithOptions({
  migrationsDirectory,
  shouldCreateStorageSchema,
  upToMigration,
  transformers = [],
}: RunMigrationOptions) {
  return async (client: BasicPgClient) => {
    let intendedMigrations = await loadMigrationFilesCached(migrationsDirectory)
    let lastMigrationId = intendedMigrations[intendedMigrations.length - 1].id

    if (upToMigration) {
      const migrationIndex = intendedMigrations.findIndex((m) => m.name === upToMigration)
      if (migrationIndex === -1) {
        throw ERRORS.InternalError(undefined, `Migration ${dbMigrationFreezeAt} not found`)
      }
      intendedMigrations = intendedMigrations.slice(0, migrationIndex + 1)
      lastMigrationId = intendedMigrations[migrationIndex].id
    }

    try {
      const migrationTableName = 'migrations'

      await client.query(`SET search_path TO ${searchPath.join(',')}`)

      let appliedMigrations: Migration[] = []
      if (await doesTableExist(client, migrationTableName)) {
        const selectQueryCurrentMigration = SQL`SELECT * FROM `
          .append(migrationTableName)
          .append(SQL` WHERE id <= ${lastMigrationId}`)

        const { rows } = await client.query(selectQueryCurrentMigration)
        appliedMigrations = rows

        if (rows.length > 0) {
          appliedMigrations = await refreshMigrationPosition(
            client,
            migrationTableName,
            appliedMigrations,
            intendedMigrations
          )
        }
      } else if (shouldCreateStorageSchema) {
        const schemaExists = await doesSchemaExists(client, 'storage')
        if (!schemaExists) {
          await client.query(`CREATE SCHEMA IF NOT EXISTS storage`)
        }
      }

      try {
        validateMigrationHashes(intendedMigrations, appliedMigrations)
      } catch (e) {
        if (!dbRefreshMigrationHashesOnMismatch) {
          throw e
        }

        await refreshMigrationHash(
          client,
          migrationTableName,
          intendedMigrations,
          appliedMigrations
        )
      }

      const migrationsToRun = filterMigrations(intendedMigrations, appliedMigrations)
      const completedMigrations = []

      if (migrationsToRun.length > 0) {
        await client.query(SQL`SELECT 
          set_config('storage.install_roles', ${dbInstallRoles}, false),
          set_config('storage.anon_role', ${dbAnonRole}, false),
          set_config('storage.authenticated_role', ${dbAuthenticatedRole}, false),
          set_config('storage.service_role', ${dbServiceRole}, false),
          set_config('storage.super_user', ${dbSuperUser}, false)
        `)
      }

      for (const migration of migrationsToRun) {
        const result = await runMigration(
          migrationTableName,
          client
        )(runMigrationTransformers(migration, transformers))
        completedMigrations.push(result)
      }

      return completedMigrations
    } catch (e) {
      const error: MigrationError = new Error(`Migration failed. Reason: ${(e as Error).message}`)
      error.cause = e + ''
      throw error
    }
  }
}

/**
 * Filter migrations that have not been applied yet
 * @param migrations
 * @param appliedMigrations
 */
function filterMigrations(
  migrations: Array<Migration>,
  appliedMigrations: Record<number, Migration | undefined>
) {
  const notAppliedMigration = (migration: Migration) => !appliedMigrations[migration.id]

  return migrations.filter(notAppliedMigration)
}

/**
 * Transforms provided migration by running all transformers
 * @param migration
 * @param transformers
 */
function runMigrationTransformers(
  migration: Migration,
  transformers: MigrationTransformer[]
): Migration {
  for (const transformer of transformers) {
    migration = transformer.transform(migration)
  }
  return migration
}

/**
 * Get the current default access method for this database
 * @param client
 */
async function getDefaultAccessMethod(client: BasicPgClient): Promise<string> {
  const result = await client.query(`SHOW default_table_access_method`)
  return result.rows?.[0]?.default_table_access_method || ''
}

/**
 * Checks if a table exists
 * @param client
 * @param tableName
 */
async function doesTableExist(client: BasicPgClient, tableName: string) {
  const result = await client.query(SQL`SELECT EXISTS (
  SELECT 1
  FROM   pg_catalog.pg_class c
  WHERE  c.relname = ${tableName}
  AND    c.relkind = 'r'
);`)

  return result.rows.length > 0 && result.rows[0].exists
}

/**
 * Check if schema exists
 * @param client
 * @param schemaName
 */
async function doesSchemaExists(client: BasicPgClient, schemaName: string) {
  const result = await client.query(SQL`SELECT EXISTS (
      SELECT 1
      FROM information_schema.schemata
      WHERE schema_name = ${schemaName}
  );`)

  return result.rows.length > 0 && result.rows[0].exists === 'true'
}

/**
 * Wraps a function with an advisory lock
 * @param waitForLock
 * @param f
 */
function withAdvisoryLock<T>(
  waitForLock: boolean,
  f: (client: BasicPgClient) => Promise<T>
): (client: BasicPgClient) => Promise<T> {
  return async (client: BasicPgClient): Promise<T> => {
    try {
      try {
        let acquired = false
        let tries = 1

        const timeout = 3000
        const start = Date.now()

        while (!acquired) {
          const elapsed = Date.now() - start
          if (elapsed > timeout) {
            throw ERRORS.LockTimeout()
          }

          const lockResult = await client.query(
            'SELECT pg_try_advisory_lock(-8525285245963000605);'
          )
          if (lockResult.rows[0].pg_try_advisory_lock === true) {
            acquired = true
          } else {
            if (waitForLock) {
              await new Promise((res) => setTimeout(res, 20 * tries))
            } else {
              throw ERRORS.LockTimeout()
            }
          }

          tries++
        }
      } catch (e) {
        throw e
      }

      return await f(client)
    } catch (e) {
      throw e
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(-8525285245963000605);')
      } catch {}
    }
  }
}

async function refreshMigrationHash(
  client: BasicPgClient,
  migrationTableName: string,
  intendedMigrations: Migration[],
  appliedMigrations: Migration[]
) {
  const invalidHash = (migration: Migration) => {
    const appliedMigration = appliedMigrations[migration.id]
    return appliedMigration != null && appliedMigration.hash !== migration.hash
  }

  // Assert migration hashes are still same
  const invalidHashes = intendedMigrations.filter(invalidHash)

  if (invalidHashes.length > 0) {
    await client.query('BEGIN')

    try {
      await Promise.all(
        invalidHashes.map((migration) => {
          const query = SQL`UPDATE `
            .append(migrationTableName)
            .append(SQL` SET hash = ${migration.hash} WHERE id = ${migration.id}`)

          return client.query(query)
        })
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
  }

  return invalidHashes
}

/**
 * Backports migrations that were added after the initial release
 *
 * @param client
 * @param migrationTableName
 * @param appliedMigrations
 * @param intendedMigrations
 */
async function refreshMigrationPosition(
  client: BasicPgClient,
  migrationTableName: string,
  appliedMigrations: Migration[],
  intendedMigrations: Migration[]
) {
  let newMigrations = [...appliedMigrations]
  let shouldUpdateMigrations = false

  backportMigrations.forEach((migration) => {
    const existingMigration = newMigrations?.[migration.index]

    if (!existingMigration || (existingMigration && existingMigration.name !== migration.from)) {
      return
    }

    // slice till the migration we want to backport
    const migrations = newMigrations.slice(0, migration.index)

    // add the migration we want to backport
    migrations.push(intendedMigrations[migration.index])

    // add the other run migrations by updating their id and hash
    const afterMigration = newMigrations.slice(migration.index).map((m) => ({
      ...m,
      id: m.id + 1,
      hash: intendedMigrations[m.id].hash,
    }))

    migrations.push(...afterMigration)
    newMigrations = migrations
    shouldUpdateMigrations = true
  })

  if (shouldUpdateMigrations) {
    await client.query(`BEGIN`)
    try {
      await client.query(`DELETE FROM ${migrationTableName} WHERE id is not NULL`)
      const query = SQL`INSERT INTO `
        .append(migrationTableName)
        .append('(id, name, hash, executed_at) VALUES ')

      newMigrations.forEach((migration, index) => {
        query.append(SQL`(${migration.id}, ${migration.name}, ${migration.hash}, NOW())`)
        if (index !== newMigrations.length - 1) {
          query.append(',')
        }
      })
      await client.query(query)
      await client.query(`COMMIT`)
    } catch (e) {
      await client.query(`ROLLBACK`)
      throw e
    }
  }

  return newMigrations
}
