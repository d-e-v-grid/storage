import dotenv from 'dotenv'
dotenv.config()

import { runMigrationsOnTenant } from '@internal/database/migrations'
import { getConfig } from '../config'
;(async () => {
  const { databaseURL, dbMigrationFreezeAt } = getConfig()
  await runMigrationsOnTenant('storage-single-tenant', {
    upToMigration: dbMigrationFreezeAt,
  })
})().catch(console.error)
