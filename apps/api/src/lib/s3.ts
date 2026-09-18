/**
 * S3 / MinIO 直传用的最小 SigV4 实现。
 *
 * 只有 PUT 一个对象这一件事要做，不值得为此拉一个 aws-sdk 进 Worker ——
 * Workers 自带 WebCrypto，签名链路（HMAC-SHA256 四次嵌套）手写不到 80 行。
 *
 * 载荷哈希用 `UNSIGNED-PAYLOAD`：MinIO 支持，省掉在 Worker 里对整段音频
 * 做一次 SHA-256（几十 MB 的文件没必要）。
 */

export type S3Env = {
  S3_ENDPOINT: string
  S3_REGION: string
  S3_BUCKET: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
}

const ALGO = "AWS4-HMAC-SHA256"
const SERVICE = "s3"
const UNSIGNED = "UNSIGNED-PAYLOAD"

function amzNow(d = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, "")
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/** S3 的 canonical uri 要求逐段编码，且 `/` 保留。 */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/")
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function signingKey(secret: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  let k = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp)
  k = await hmac(k, region)
  k = await hmac(k, SERVICE)
  k = await hmac(k, "aws4_request")
  return k
}

/** 对象在桶里的最终公开地址（path-style：/bucket/key）。 */
export function publicUrl(env: { S3_PUBLIC_BASE_URL: string; S3_BUCKET: string }, key: string): string {
  const base = env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "")
  return `${base}/${env.S3_BUCKET}/${encodePath(key)}`
}

async function s3Request(
  env: S3Env,
  method: "PUT" | "DELETE",
  key: string,
  body: ArrayBuffer | null,
  contentType: string,
): Promise<void> {
  const url = new URL(env.S3_ENDPOINT)
  const host = url.host
  // path-style：/bucket/key（这个 MinIO 实例就是这么对外提供文件的）
  const canonicalUri = `/${env.S3_BUCKET}/${encodePath(key)}`
  const { amzDate, dateStamp } = amzNow()

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": amzDate,
  }
  // DELETE 不带 content-type，签了空头反而容易被拒
  if (contentType) headers["content-type"] = contentType
  const signedKeys = Object.keys(headers).sort()
  const canonicalHeaders = signedKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join("")
  const signedHeaders = signedKeys.join(";")

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // query string
    canonicalHeaders,
    signedHeaders,
    UNSIGNED,
  ].join("\n")

  const scope = `${dateStamp}/${env.S3_REGION}/${SERVICE}/aws4_request`
  const stringToSign = [ALGO, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n")
  const sig = hex(await hmac(await signingKey(env.S3_SECRET_ACCESS_KEY, dateStamp, env.S3_REGION), stringToSign))

  headers.authorization = `${ALGO} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
  delete headers.host // fetch 自己会带，重复会出错

  const res = await fetch(`${url.origin}${canonicalUri}`, {
    method,
    headers,
    body: body ?? undefined,
  })
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    const text = (await res.text().catch(() => "")).slice(0, 300)
    throw new Error(`S3 ${method} 失败 ${res.status}: ${text}`)
  }
}

export async function putObject(
  env: S3Env,
  key: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await s3Request(env, "PUT", key, body, contentType)
}

/** 删掉桶里的对象（删课、清理测试数据时用）。对象不存在也算成功。 */
export async function deleteObject(env: S3Env, key: string): Promise<void> {
  await s3Request(env, "DELETE", key, null, "")
}

/**
 * 从课程的 `audioUrl` 反推出桶内对象 key。
 *
 * `publicUrl` 形如 `${base}/${bucket}/${key}`，所以路径第一段是 bucket，剩下的是 key。
 * 只在 bucket 段与当前 env 一致时才返回，避免误删其它桶 / 其它来源的对象；
 * 解析不出来（非本桶 URL、格式异常）返回 null。
 */
export function objectKeyFromUrl(env: S3Env, audioUrl: string): string | null {
  try {
    const u = new URL(audioUrl)
    const segs = u.pathname.split("/").filter(Boolean)
    if (segs.length < 2) return null
    const [bucket, ...rest] = segs
    if (bucket !== env.S3_BUCKET) return null
    // host 也要匹配 endpoint，挡住「别的 host 恰好 bucket 段撞车」的误删
    if (u.host !== new URL(env.S3_ENDPOINT).host) return null
    return decodeURIComponent(rest.join("/"))
  } catch {
    return null
  }
}
