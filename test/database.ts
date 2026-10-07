import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { openDatabase } from '../src/db.js'

export async function testDatabase() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('Configura TEST_DATABASE_URL con una base PostgreSQL exclusiva para pruebas.')
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const schema = `foliovio_test_${randomUUID().replaceAll('-', '')}`
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = await openDatabase(url, { schema })
    const cleanup = async () => {
      try {
        await db.close()
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally { await admin.end() }
    }
    return { db, url, schema, cleanup }
  } catch (error) {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
    throw error
  }
}
