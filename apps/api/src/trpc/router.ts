import { publicProcedure, router } from "./init"
import { todoRouter } from "./routers/todo"
import { lessonRouter } from "./routers/lesson"
import { attemptRouter } from "./routers/attempt"
import { wbRouter } from "./routers/wb"
import { adminRouter } from "./routers/admin"

export const appRouter = router({
  health: publicProcedure.query(() => "OK"),
  todos: todoRouter,
  lessons: lessonRouter,
  attempts: attemptRouter,
  wb: wbRouter,
  admin: adminRouter,
})

export type AppRouter = typeof appRouter
