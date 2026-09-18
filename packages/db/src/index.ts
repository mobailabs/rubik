import { drizzle } from "drizzle-orm/neon-http"
import * as schema from "./schema"

export function createDB(databaseUrl: string) {
  return drizzle(databaseUrl, { schema })
}

export * from "./schema"
export {
  eq,
  and,
  or,
  not,
  desc,
  asc,
  count,
  inArray,
  ilike,
  lte,
  gte,
  sql,
} from "drizzle-orm"
export { alias } from "drizzle-orm/pg-core"
