import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * A GET that always opens its own connection and closes it when the response ends. It never goes
 * through the shared keep-alive pool of the global `fetch`, so a pooled socket that died with a
 * network change (VPN up or down, interface switch) cannot be picked again. Used by the REST
 * pollers after a failure and while a general connectivity problem lasts.
 */
export function freshConnectionFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const url = new URL(input)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    headers.connection = 'close'
    const request = send(
      url,
      {
        method: init?.method ?? 'GET',
        headers,
        agent: false,
        signal: init?.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            request.destroy(new RangeError('Response exceeds 8 MiB.'))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(response.headers))
            if (typeof value === 'string') responseHeaders.set(key, value)
          const status = response.statusCode ?? 502
          resolve(
            new Response(status === 204 ? null : Buffer.concat(chunks), {
              status,
              headers: responseHeaders,
            }),
          )
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}
