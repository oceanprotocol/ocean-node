import { expect } from 'chai'
import {
  P2P_BUDGET_CAP,
  P2P_TIMEOUT_DEFAULTS,
  P2P_TIMEOUTS,
  SENDTO_MAX_ATTEMPTS_CAP,
  normalizeP2pBudget
} from '../../../components/P2P/timeouts.js'
import { OceanNodeP2PConfigSchema } from '../../../utils/config/schemas.js'
import { ENV_TO_CONFIG_MAPPING } from '../../../utils/config/constants.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'

/**
 * Every P2P budget is read twice: once by the validated configuration and once, at the moment
 * of use, by the getter that the networking code consults. The two halves have disagreed twice
 * already - a blank value became `0` on one side and the documented default on the other, and a
 * malformed value made one side refuse to boot while the other shrugged - so what is pinned
 * here is not either half's behaviour but the fact that they produce the *same* number.
 */

interface BudgetCase {
  readonly raw: string
  readonly why: string
  readonly expected: number
}

const SENDTO_TOTAL_DEFAULT = P2P_TIMEOUT_DEFAULTS.sendToTotalMs

const cases: BudgetCase[] = [
  {
    raw: '',
    why: 'blank, the idiom the sample environment file uses',
    expected: SENDTO_TOTAL_DEFAULT
  },
  { raw: '   ', why: 'whitespace only', expected: SENDTO_TOTAL_DEFAULT },
  {
    raw: '15s',
    why: 'non-numeric, a plausible operator typo',
    expected: SENDTO_TOTAL_DEFAULT
  },
  { raw: 'NaN', why: 'literally NaN', expected: SENDTO_TOTAL_DEFAULT },
  { raw: 'Infinity', why: 'not finite', expected: SENDTO_TOTAL_DEFAULT },
  {
    raw: '0',
    why: 'zero would disable the budget entirely',
    expected: SENDTO_TOTAL_DEFAULT
  },
  { raw: '-5', why: 'negative', expected: SENDTO_TOTAL_DEFAULT },
  { raw: '1500.7', why: 'fractional milliseconds have no meaning', expected: 1500 },
  {
    raw: '25',
    why: 'below the floor under which a budget aborts before the work can start',
    expected: SENDTO_TOTAL_DEFAULT
  },
  {
    raw: '10000000000',
    why: 'above the 32-bit timer ceiling, where setTimeout fires after 1ms instead of never',
    expected: P2P_BUDGET_CAP
  },
  { raw: '30000', why: 'a valid override', expected: 30000 }
]

describe('P2P budgets: the validated config and the getter must never disagree', () => {
  const KEY = 'P2P_SENDTO_TOTAL_MS'
  let saved: string | undefined

  before(() => {
    saved = process.env[KEY]
  })

  after(() => {
    if (saved === undefined) {
      delete process.env[KEY]
    } else {
      process.env[KEY] = saved
    }
  })

  for (const testCase of cases) {
    it(`agrees on "${testCase.raw}" (${testCase.why})`, () => {
      process.env[KEY] = testCase.raw
      const fromGetter = P2P_TIMEOUTS.sendToTotalMs
      const fromSchema = OceanNodeP2PConfigSchema.parse({
        sendToTotalTimeout: testCase.raw
      }).sendToTotalTimeout

      expect(fromGetter).to.equal(testCase.expected)
      expect(fromSchema).to.equal(testCase.expected)
      expect(fromSchema).to.equal(fromGetter)
    })
  }

  it('applies the attempt cap identically on both halves', () => {
    const key = 'P2P_SENDTO_MAX_ATTEMPTS'
    const previous = process.env[key]
    try {
      process.env[key] = '1000'
      const fromGetter = P2P_TIMEOUTS.sendToMaxAttempts
      const fromSchema = OceanNodeP2PConfigSchema.parse({
        sendToMaxAttempts: '1000'
      }).sendToMaxAttempts
      // an uncapped attempt count multiplies the whole per-attempt budget by itself
      expect(fromGetter).to.equal(SENDTO_MAX_ATTEMPTS_CAP)
      expect(fromSchema).to.equal(fromGetter)
    } finally {
      if (previous === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous
      }
    }
  })

  /**
   * These reach the schema only from a JSON configuration file, where the types are real -
   * `Number()` would happily turn `true` into a 1ms budget and `[5]` into 5ms.
   */
  it('ignores values whose type could never be a budget', () => {
    const parsed = OceanNodeP2PConfigSchema.parse({
      streamIdleTimeout: true,
      findPeerTimeout: [5],
      advertiseTimeout: null
    })
    expect(parsed.streamIdleTimeout).to.equal(P2P_TIMEOUT_DEFAULTS.streamIdleMs)
    expect(parsed.findPeerTimeout).to.equal(P2P_TIMEOUT_DEFAULTS.findPeerMs)
    expect(parsed.advertiseTimeout).to.equal(P2P_TIMEOUT_DEFAULTS.advertiseMs)
  })

  it('never rejects a malformed budget hard enough to stop the node booting', () => {
    // the whole point of falling back rather than throwing: a typo in a tuning knob must not be
    // startup-fatal
    expect(() =>
      OceanNodeP2PConfigSchema.parse({ sendToDialTimeout: '15s' })
    ).to.not.throw()
    expect(normalizeP2pBudget('15s')).to.equal(undefined)
  })

  it('clamps a budget to a value the timer primitives can actually hold', async () => {
    process.env[KEY] = '10000000000'
    const budget = P2P_TIMEOUTS.sendToTotalMs
    expect(budget).to.equal(P2P_BUDGET_CAP)

    // Above the cap, setTimeout warns and fires after 1ms - so an enormous budget aborted every
    // call instantly instead of granting one. A clamped budget must still be in the future.
    let fired = false
    const timer = setTimeout(() => {
      fired = true
    }, budget)
    await new Promise((resolve) => setTimeout(resolve, 50))
    clearTimeout(timer)
    expect(fired).to.equal(false)

    // and above 4294967295 AbortSignal.timeout throws outright, which the same clamp prevents
    expect(() => AbortSignal.timeout(budget)).to.not.throw()
  })
})

/**
 * A new budget has to be declared on five surfaces before it works: the defaults record, the
 * getter, the zod schema, the environment-to-config mapping, and the generated environment
 * catalogue. Miss any one and the knob is documented but inert - which has already happened
 * twice in this subsystem, once for `P2P_SENDTO_TOTAL_MS` and once for the two FindDDO budgets,
 * whose values were re-declared as literals in the handler that consumed them. So each key is
 * driven through all five here rather than eyeballed.
 */
describe('every P2P budget reaches all of its declaration sites', () => {
  interface KnobCase {
    readonly env: string
    readonly configKey: keyof ReturnType<typeof OceanNodeP2PConfigSchema.parse>
    readonly getter: () => number
    readonly expectedDefault: number
    readonly override: string
  }

  const knobs: KnobCase[] = [
    {
      env: 'P2P_FINDDDO_PROVIDER_TIMEOUT_MS',
      configKey: 'findDdoProviderTimeout',
      getter: () => P2P_TIMEOUTS.findDdoProviderMs,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.findDdoProviderMs,
      override: '7000'
    },
    {
      env: 'P2P_DDO_NOT_FOUND_CACHE_MS',
      configKey: 'ddoNotFoundCacheTimeout',
      getter: () => P2P_TIMEOUTS.ddoNotFoundCacheMs,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.ddoNotFoundCacheMs,
      override: '20000'
    },
    {
      env: 'P2P_RESOLVE_CACHE_MS',
      configKey: 'resolveCacheTimeout',
      getter: () => P2P_TIMEOUTS.resolveCacheMs,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.resolveCacheMs,
      override: '31000'
    },
    {
      env: 'P2P_RESOLVE_NEGATIVE_CACHE_MS',
      configKey: 'resolveNegativeCacheTimeout',
      getter: () => P2P_TIMEOUTS.resolveNegativeCacheMs,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.resolveNegativeCacheMs,
      override: '9000'
    },
    {
      env: 'P2P_SENDTO_MAX_CONCURRENCY',
      configKey: 'sendToMaxConcurrency',
      getter: () => P2P_TIMEOUTS.sendToMaxConcurrency,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.sendToMaxConcurrency,
      override: '8'
    },
    {
      env: 'P2P_READY_MIN_ROUTING_PEERS',
      configKey: 'readyMinRoutingPeers',
      getter: () => P2P_TIMEOUTS.dhtReadyMinPeers,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.dhtReadyMinPeers,
      override: '7'
    },
    {
      env: 'P2P_INITIAL_QUERY_SELF_MS',
      configKey: 'initialQuerySelfTimeout',
      getter: () => P2P_TIMEOUTS.initialQuerySelfMs,
      expectedDefault: P2P_TIMEOUT_DEFAULTS.initialQuerySelfMs,
      override: '25000'
    }
  ]

  for (const knob of knobs) {
    it(`${knob.env} moves the getter, the schema and the catalogue together`, () => {
      const previous = process.env[knob.env]
      try {
        // The blank idiom `.env.example` uses has to reach the documented default, not 0.
        process.env[knob.env] = ''
        expect(knob.getter(), 'a blank value must fall back').to.equal(
          knob.expectedDefault
        )
        expect(
          (OceanNodeP2PConfigSchema.parse({ [knob.configKey]: '' }) as any)[
            knob.configKey
          ]
        ).to.equal(knob.expectedDefault)

        process.env[knob.env] = knob.override
        const expected = Number(knob.override)
        expect(knob.getter()).to.equal(expected)
        expect(
          (
            OceanNodeP2PConfigSchema.parse({
              [knob.configKey]: knob.override
            }) as any
          )[knob.configKey]
        ).to.equal(expected)

        // The mapping is what puts the key into the generated catalogue, so this covers both.
        expect(
          ENV_TO_CONFIG_MAPPING[knob.env as keyof typeof ENV_TO_CONFIG_MAPPING],
          'the key must be mapped into the validated config'
        ).to.equal(`p2pConfig.${String(knob.configKey)}`)
        expect(
          ENVIRONMENT_VARIABLES[knob.env]?.name,
          'the key must appear in the generated environment catalogue'
        ).to.equal(knob.env)
      } finally {
        if (previous === undefined) {
          delete process.env[knob.env]
        } else {
          process.env[knob.env] = previous
        }
      }
    })
  }

  it('no longer carries the inter-provider back-off, which nothing consumes', () => {
    // FindDDO queries providers concurrently, so there is no interval between them to
    // configure. A documented knob wired to nothing is worse than no knob.
    expect('P2P_PROVIDER_RETRY_SLEEP_MS' in ENV_TO_CONFIG_MAPPING).to.equal(false)
    expect(ENVIRONMENT_VARIABLES.P2P_PROVIDER_RETRY_SLEEP_MS).to.equal(undefined)
  })
})
