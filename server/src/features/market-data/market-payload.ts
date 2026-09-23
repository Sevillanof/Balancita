import {
  invalid,
  isRecord,
  issue,
  valid,
  type ValidationResult,
} from '../../platform/validation.ts'

export interface NormalizedTickerPayload {
  readonly type: 'ticker'
  readonly productId: 'BTC-EUR'
  readonly tradeId: number
  readonly sequence: number
  readonly price: number
  readonly bestBid?: number
  readonly bestAsk?: number
  readonly size?: number
  readonly open24h?: number
}

export interface NormalizedHeartbeatPayload {
  readonly type: 'heartbeat'
  readonly productId: 'BTC-EUR'
  readonly sequence: number
  readonly lastTradeId: number
}

export type TradeSide = 'buy' | 'sell'

export interface NormalizedTradePayload {
  readonly type: 'trade'
  readonly productId: 'BTC-EUR'
  readonly tradeId: number
  readonly sequence: number
  readonly price: number
  readonly qty: number
  readonly side: TradeSide
  readonly orderType?: 'limit' | 'market'
}

export type NormalizedMarketPayload =
  NormalizedTickerPayload | NormalizedHeartbeatPayload | NormalizedTradePayload

export function validateNormalizedMarketPayload(
  input: unknown,
): ValidationResult<NormalizedMarketPayload> {
  if (!isRecord(input)) {
    return invalid([
      issue(
        'invalid_payload',
        'payload',
        'Normalized market payload must be an object.',
      ),
    ])
  }

  const issues = []
  if (input.productId !== 'BTC-EUR') {
    issues.push(
      issue(
        'unsupported_instrument',
        'payload.productId',
        'Only BTC-EUR is supported.',
      ),
    )
  }
  if (
    input.type !== 'ticker' &&
    input.type !== 'heartbeat' &&
    input.type !== 'trade'
  ) {
    issues.push(
      issue(
        'invalid_payload_type',
        'payload.type',
        'Payload type is not supported.',
      ),
    )
  }
  if (!safeInteger(input.sequence)) {
    issues.push(
      issue(
        'invalid_payload_sequence',
        'payload.sequence',
        'Payload sequence must be a non-negative safe integer.',
      ),
    )
  }

  if (input.type === 'ticker') {
    if (!safeInteger(input.tradeId)) {
      issues.push(
        issue(
          'invalid_trade_id',
          'payload.tradeId',
          'Ticker trade id must be a non-negative safe integer.',
        ),
      )
    }
    if (!positiveFinite(input.price)) {
      issues.push(
        issue(
          'invalid_price',
          'payload.price',
          'Ticker price must be finite and positive.',
        ),
      )
    }
    for (const field of ['bestBid', 'bestAsk', 'size', 'open24h'] as const) {
      if (input[field] !== undefined && !positiveFinite(input[field])) {
        issues.push(
          issue(
            'invalid_payload_number',
            `payload.${field}`,
            `${field} must be finite and positive when present.`,
          ),
        )
      }
    }
  } else if (input.type === 'heartbeat' && !safeInteger(input.lastTradeId)) {
    issues.push(
      issue(
        'invalid_trade_id',
        'payload.lastTradeId',
        'Heartbeat last trade id must be a non-negative safe integer.',
      ),
    )
  } else if (input.type === 'trade') {
    if (!safeInteger(input.tradeId)) {
      issues.push(
        issue(
          'invalid_trade_id',
          'payload.tradeId',
          'Trade id must be a non-negative safe integer.',
        ),
      )
    }
    if (!positiveFinite(input.price)) {
      issues.push(
        issue(
          'invalid_price',
          'payload.price',
          'Trade price must be finite and positive.',
        ),
      )
    }
    if (!positiveFinite(input.qty)) {
      issues.push(
        issue(
          'invalid_qty',
          'payload.qty',
          'Trade quantity must be finite and positive.',
        ),
      )
    }
    if (!isSide(input.side)) {
      issues.push(
        issue(
          'invalid_side',
          'payload.side',
          'Trade side must be buy or sell.',
        ),
      )
    }
    if (
      input.orderType !== undefined &&
      input.orderType !== 'limit' &&
      input.orderType !== 'market'
    ) {
      issues.push(
        issue(
          'invalid_order_type',
          'payload.orderType',
          'Trade order type must be limit or market when present.',
        ),
      )
    }
  }

  if (issues.length > 0) return invalid(issues)
  if (input.type === 'ticker') {
    return valid({
      type: 'ticker',
      productId: 'BTC-EUR',
      tradeId: input.tradeId as number,
      sequence: input.sequence as number,
      price: input.price as number,
      ...(input.bestBid === undefined
        ? {}
        : { bestBid: input.bestBid as number }),
      ...(input.bestAsk === undefined
        ? {}
        : { bestAsk: input.bestAsk as number }),
      ...(input.size === undefined ? {} : { size: input.size as number }),
      ...(input.open24h === undefined
        ? {}
        : { open24h: input.open24h as number }),
    })
  }
  if (input.type === 'trade') {
    return valid({
      type: 'trade',
      productId: 'BTC-EUR',
      tradeId: input.tradeId as number,
      sequence: input.sequence as number,
      price: input.price as number,
      qty: input.qty as number,
      side: input.side as TradeSide,
      ...(input.orderType === undefined
        ? {}
        : { orderType: input.orderType as 'limit' | 'market' }),
    })
  }
  return valid({
    type: 'heartbeat',
    productId: 'BTC-EUR',
    sequence: input.sequence as number,
    lastTradeId: input.lastTradeId as number,
  })
}

function isSide(value: unknown): value is TradeSide {
  return value === 'buy' || value === 'sell'
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
