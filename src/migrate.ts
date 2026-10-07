import { readConfig } from './config.js'
import { openDatabase } from './db.js'

const db = await openDatabase(readConfig().databaseUrl)
await db.close()
console.log('Migraciones PostgreSQL aplicadas.')
