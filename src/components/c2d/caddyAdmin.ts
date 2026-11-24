import http from 'http'

export const CADDY_ADMIN_SOCKET = '/run/caddy/admin.sock'
const CADDY_TIMEOUT_MS = 5000

// The request body is never put in an error or a log line.
export function caddyPost(
  path: string,
  json: string,
  socketPath = CADDY_ADMIN_SOCKET
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: 'POST',
        timeout: CADDY_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', Host: 'localhost' }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) return resolve()
          const text = Buffer.concat(chunks).toString().slice(0, 200)
          reject(new Error(`caddy admin POST ${path}: ${status} ${text}`))
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`caddy admin POST ${path}: timed out`)))
    req.on('error', reject)
    req.end(json)
  })
}
