import { createHash } from 'node:crypto'

const ENDPOINT =
  'https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=PF_XBTUSD'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type HistoricalFundingRecord = Readonly<{
  startMs: number
  endMs: number
  fundingRate: string
  unit: 'USD/BTC/hour'
  knownAtMs: number
  serverTime: string
  sha256: string
  rawResponse: string
}>

export type HistoricalFundingResponse = Readonly<{
  serverTime: string
  receivedAtMs: number
  sha256: string
  rawResponse: string
  records: readonly HistoricalFundingRecord[]
}>

export type HistoricalFundingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export function parseHistoricalFundingResponse(
  raw: string,
  receivedAtMs: number,
): HistoricalFundingResponse {
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0)
    throw new TypeError('Funding received time is invalid.')
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES)
    throw new RangeError('Historical funding response exceeds 2 MiB.')
  const body: unknown = JSON.parse(raw)
  if (
    !isRecord(body) ||
    body.result !== 'success' ||
    !Array.isArray(body.rates)
  )
    throw new TypeError('Invalid historical funding response schema.')
  if (
    typeof body.serverTime !== 'string' ||
    !Number.isFinite(Date.parse(body.serverTime))
  )
    throw new TypeError('Invalid historical funding server time.')
  const serverTimeMs = Date.parse(body.serverTime)
  const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  const rawRateLexemes = [
    ...raw.matchAll(
      /"fundingRate"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    ),
  ].map((match) => match[1]!)
  const records = new Map<number, HistoricalFundingRecord>()
  const rates = body.rates
  for (const [index, rate] of rates.entries()) {
    if (!isRecord(rate) || typeof rate.timestamp !== 'string')
      throw new TypeError('Invalid historical funding period.')
    if (
      typeof rate.relativeFundingRate !== 'number' ||
      !Number.isFinite(rate.relativeFundingRate)
    )
      throw new TypeError('Invalid historical relative funding field.')
    const startMs = Date.parse(rate.timestamp)
    if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > serverTimeMs)
      throw new TypeError('Historical funding period is future-dated.')
    const lexeme = rawRateLexemes[index]
    if (
      !lexeme ||
      typeof rate.fundingRate !== 'number' ||
      !Number.isFinite(rate.fundingRate)
    )
      throw new TypeError('Historical funding rate is invalid.')
    const record: HistoricalFundingRecord = {
      startMs,
      endMs: startMs + 3_600_000,
      fundingRate: exactDecimal(lexeme),
      unit: 'USD/BTC/hour',
      knownAtMs: receivedAtMs,
      serverTime: body.serverTime,
      sha256,
      rawResponse: raw,
    }
    const prior = records.get(startMs)
    if (prior && prior.fundingRate !== record.fundingRate)
      throw new Error('Conflicting funding rates for one period.')
    records.set(startMs, record)
  }
  return {
    serverTime: body.serverTime,
    receivedAtMs,
    sha256,
    rawResponse: raw,
    records: [...records.values()].sort((a, b) => a.startMs - b.startMs),
  }
}

export function historicalFundingAt(
  records: readonly HistoricalFundingRecord[],
  decisionAtMs: number,
  cutoffKnownAtMs: number,
): HistoricalFundingRecord | null {
  if (
    !Number.isSafeInteger(decisionAtMs) ||
    !Number.isSafeInteger(cutoffKnownAtMs)
  )
    return null
  const active = records.filter(
    (record) =>
      record.startMs <= decisionAtMs &&
      decisionAtMs < record.endMs &&
      record.knownAtMs <= cutoffKnownAtMs &&
      record.knownAtMs <= decisionAtMs,
  )
  if (active.length === 0) return null
  const unique = new Set(active.map((record) => record.fundingRate))
  return unique.size === 1 ? active.at(-1)! : null
}

export function createHistoricalFundingClient(
  options: {
    fetch?: HistoricalFundingFetch
    clock?: () => number
    timeoutMs?: number
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new RangeError(
      'Funding request timeout must be between 1 and 30000 ms.',
    )
  const fetcher =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const controllers = new Set<AbortController>()
  let closed = false
  return {
    async fetch(receivedAtMs?: number): Promise<HistoricalFundingResponse> {
      if (closed) throw new Error('Historical funding client is closed.')
      const controller = new AbortController()
      controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetcher(ENDPOINT, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        const declaredLength = Number(
          response.headers.get('content-length') ?? 0,
        )
        if (declaredLength > MAX_RESPONSE_BYTES)
          throw new RangeError('Historical funding response exceeds 2 MiB.')
        if (!response.ok)
          throw new Error(`Historical funding HTTP ${response.status}.`)
        const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES)
        if (bytes.byteLength > MAX_RESPONSE_BYTES)
          throw new RangeError('Historical funding response exceeds 2 MiB.')
        const responseReceivedAtMs = options.clock?.() ?? receivedAtMs
        if (responseReceivedAtMs === undefined)
          throw new TypeError('Funding response receipt time is required.')
        return parseHistoricalFundingResponse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          responseReceivedAtMs,
        )
      } finally {
        clearTimeout(timeout)
        controllers.delete(controller)
      }
    },
    close(): void {
      closed = true
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}

async function readBoundedBody(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit)
      throw new RangeError('Historical funding response exceeds 2 MiB.')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new RangeError('Historical funding response exceeds 2 MiB.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function exactDecimal(value: string): string {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/)
  if (!match) throw new TypeError('Funding decimal lexeme is invalid.')
  const sign = match[1]!
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100)
    throw new RangeError('Funding decimal exponent is out of range.')
  const digits = `${match[2]}${fraction}`
  const point = match[2]!.length + exponent
  let result =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`
  if (result.includes('.'))
    result = result.replace(/0+$/, '').replace(/\.$/, '')
  result = result.replace(/^(-?)0+(?=\d)/, '$1')
  if (result.startsWith('.')) result = `0${result}`
  if (result.startsWith('-.')) result = result.replace('-.', '-0.')
  return /^-?0(?:\.0*)?$/.test(result)
    ? '0'
    : `${sign && result !== '0' ? '-' : ''}${result}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
