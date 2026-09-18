import { Hono } from "hono"
import { cors } from "hono/cors"
import { trpcServer } from "@hono/trpc-server"
import { createDB } from "@repo/db"
import { appRouter } from "./trpc/router"
import { createAuth } from "./auth"
import uploadRoutes from "./routes/upload"
import { isLocalEnv } from "./lib/dev"

const app = new Hono<{ Bindings: Env }>()

// dev 反射浏览器实际来源（含 LAN/CGNAT 地址），方便远程设备联调；
// 生产仍只认 APP_URL，不开放跨域。
app.use("*", (c, next) =>
  cors({
    origin: (origin) => (origin && isLocalEnv(c.env) ? origin : c.env.APP_URL),
    credentials: true,
  })(c, next),
)

app.all("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw))

// 上传 / 转写回传（/api/upload、/api/ingest/*）
app.route("/", uploadRoutes)

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: async (_opt, c) => {
      const session = await createAuth(c.env).api.getSession({
        headers: c.req.raw.headers,
      })
      return {
        db: createDB(c.env.DATABASE_URL),
        user: session?.user ?? null,
        s3: {
          S3_ENDPOINT: c.env.S3_ENDPOINT,
          S3_REGION: c.env.S3_REGION,
          S3_BUCKET: c.env.S3_BUCKET,
          S3_ACCESS_KEY_ID: c.env.S3_ACCESS_KEY_ID,
          S3_SECRET_ACCESS_KEY: c.env.S3_SECRET_ACCESS_KEY,
        },
      }
    },
  }),
)

export default app
