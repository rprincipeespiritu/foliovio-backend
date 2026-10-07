import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { readConfig } from './config.js'
import { openDatabase } from './db.js'

const config = readConfig()
const db = await openDatabase(config.databaseUrl)
const app = createApp(db, config)
const server = serve({ fetch: app.fetch, port: config.port, hostname: '::' }, () => {
  console.log(`Foliovio API en http://localhost:${config.port}`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { void db.close().then(() => process.exit(0)) }))
}
