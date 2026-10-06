import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { readConfig } from './config.js'
import { openDatabase } from './db.js'

const config = readConfig()
const db = openDatabase(config.databasePath)
const app = createApp(db, config)
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Foliovio API en http://localhost:${config.port}`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { db.close(); process.exit(0) }))
}
