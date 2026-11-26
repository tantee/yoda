import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export function createDb(url: string): Db {
  return drizzle(postgres(url), { schema })
}

/** The postgres.js client under drizzle: LISTEN (settings/live.ts) and shutdown. */
export function pgClient(db: Db): postgres.Sql {
  return (db as unknown as { $client: postgres.Sql }).$client
}
