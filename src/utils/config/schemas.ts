import { z } from 'zod'
import { getAddress } from 'ethers'
import { dhtFilterMethod } from '../../@types/OceanNode.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import {
  DEFAULT_SERVICE_MAX_DURATION_SECONDS,
  DEFAULT_SERVICE_MIN_DURATION_SECONDS
} from '../../@types/C2D/ServiceOnDemand.js'
import { CONFIG_LOGGER } from '../logging/common.js'
import { booleanFromString, jsonFromString } from './transforms.js'
import {
  DEFAULT_BOOTSTRAP_ADDRESSES,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_UNSAFE_URLS,
  DEFAULT_FILTER_ANNOUNCED_ADDRESSES,
  DEFAULT_DB_INIT_MAX_ATTEMPTS,
  DEFAULT_DB_INIT_RETRY_DELAY,
  DEFAULT_DB_INIT_MAX_RETRY_DELAY
} from './constants.js'
import {
  P2P_TIMEOUT_DEFAULTS,
  P2P_BUDGET_MIN_MS,
  SENDTO_MAX_ATTEMPTS_CAP,
  SENDTO_MAX_CONCURRENCY_CAP,
  normalizeP2pBudget
} from '../../components/P2P/timeouts.js'

function isValidUrl(urlString: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(urlString)
    return true
  } catch {
    return false
  }
}

/**
 * One schema shape for every P2P timeout / attempt budget.
 *
 * `z.coerce.number()` with no positivity constraint disagreed with `timeouts.ts` in two ways
 * that were both measured:
 *
 *   - `P2P_SENDTO_DIAL_MS=` (the empty-value idiom every line of `.env.example` uses) reached
 *     the schema as `''`, coerced to `0`, and passed validation - so `config` said 0ms while
 *     the code used 15000ms;
 *   - `P2P_SENDTO_DIAL_MS=15s` coerced to `NaN`, which `z.number()` rejects, so
 *     `buildConfig` threw and **the node refused to boot** - the exact opposite of the
 *     behaviour `timeouts.ts` documents ("a blank, malformed, zero or negative value is
 *     ignored"). Adding 13 keys to the schema had silently turned a lenient fallback into a
 *     startup-fatal for a typo in a tuning knob.
 *
 * The rule is now shared code, not a re-implementation: `normalizeP2pBudget` is the same
 * function the `P2P_TIMEOUTS` getters use, so the schema and the getters cannot drift. Anything
 * it rejects becomes `undefined` here, which lets `.default()` supply exactly the number the
 * getter would have fallen back to. `.int().positive()` is declared on the inner schema as
 * well - it can only ever be reached by a value that came straight from `config.json`, and it
 * keeps the constraint visible in the schema itself.
 *
 * `max` and `min` are the same bounds the matching getter passes, and they have to be passed
 * on both halves or the two disagree again - that drift is the whole reason the rule is shared
 * code. Millisecond budgets take `P2P_BUDGET_MIN_MS`; the two keys that are counts rather than
 * durations take no floor beyond the implicit 1.
 */
const p2pBudget = (fallback: number, max?: number, min?: number) =>
  z.preprocess(
    (value) => normalizeP2pBudget(value, max, min),
    z.number().int().positive().optional().default(fallback)
  )

export const SupportedNetworkSchema = z.object({
  chainId: z.number(),
  rpc: z.string(),
  network: z.string().optional(),
  chunkSize: z.number().optional(),
  startBlock: z.number().optional(),
  fallbackRPCs: z.array(z.string()).optional()
})

export const RPCSSchema = z.record(z.string(), SupportedNetworkSchema)

export const AccessListContractSchema = z.preprocess(
  (val) => {
    // If it's not a plain object, normalize to null
    if (val === null) return null
    // If it's a JSON string, try to parse it
    if (typeof val === 'string') {
      try {
        val = JSON.parse(val)
      } catch {
        return null
      }
    }

    if (typeof val !== 'object' || Array.isArray(val)) return null

    return val
  },
  z.record(z.string(), z.array(z.string())).nullable()
)

export const OceanNodeConfigKeysSchema = z.object({
  privateKey: z.any().optional().nullable(),
  type: z.string().optional().default('raw')
})

export const DenyListSchema = z.object({
  peers: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([])
})

export const FeeAmountSchema = z.object({
  amount: z.number(),
  unit: z.string()
})

export const FeeTokensSchema = z.object({
  chain: z.string(),
  token: z.string()
})

export const FeeStrategySchema = z.object({
  feeTokens: z.array(FeeTokensSchema).optional(),
  feeAmount: FeeAmountSchema.optional()
})

export const OceanNodeDBConfigSchema = z.object({
  url: z.string().nullable(),
  username: z.string().optional(),
  password: z.string().optional(),
  dbType: z.string().nullable()
})

export const PersistentStorageConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    type: z.enum(['localfs', 's3']).optional().default('localfs'),
    accessLists: jsonFromString(z.array(z.record(z.string(), z.array(z.string()))))
      .optional()
      .default([]),
    options: z.any().optional()
  })
  .superRefine((data, ctx) => {
    if (!data.enabled) return

    if (data.type === 'localfs') {
      if (!data.options || typeof data.options !== 'object') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'persistentStorage.options must be an object for localfs',
          path: ['options']
        })
        return
      }
      if (
        typeof (data.options as any).folder !== 'string' ||
        !(data.options as any).folder
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'persistentStorage.options.folder is required for localfs',
          path: ['options', 'folder']
        })
      }
    }

    if (data.type === 's3') {
      if (!data.options || typeof data.options !== 'object') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'persistentStorage.options must be an object for s3',
          path: ['options']
        })
        return
      }
      const required = ['endpoint', 'objectKey', 'accessKeyId', 'secretAccessKey']
      for (const key of required) {
        if (
          typeof (data.options as any)[key] !== 'string' ||
          !(data.options as any)[key]
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `persistentStorage.options.${key} is required for s3`,
            path: ['options', key]
          })
        }
      }
    }
  })

export const DockerRegistryAuthSchema = z
  .object({
    username: z.string().optional(),
    password: z.string().optional(),
    auth: z.string().optional()
  })
  .refine(
    (data) => {
      // Either 'auth' is provided, OR both 'username' and 'password' are provided
      return (
        (data.auth !== undefined && data.auth !== '') ||
        (data.username !== undefined &&
          data.username !== '' &&
          data.password !== undefined &&
          data.password !== '')
      )
    },
    {
      message:
        "Either 'auth' must be provided, or both 'username' and 'password' must be provided"
    }
  )

export const DockerRegistrysSchema = z.record(z.string(), DockerRegistryAuthSchema)

// A constraint targets EITHER a single resource by `id` OR a group of resources by `type`
// (aggregated). `perUnit` (default true) keeps the historical ratio semantics
// (requiredMin = parentAmount * min); `perUnit:false` makes min/max an absolute floor/ceiling
// enforced only when the parent resource is requested.
// NOTE: keep `perUnit` optional() with no .default() — a default would inject `perUnit:true`
// into every parsed constraint and break existing deep-equal expectations on constraints.
const ResourceConstraintSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    perUnit: z.boolean().optional(),
    aggregate: z.boolean().optional()
  })
  .refine((c) => c.id !== undefined || c.type !== undefined, {
    message: 'Each resource constraint must specify either "id" or "type"'
  })
  .refine((c) => !(c.id !== undefined && c.type !== undefined), {
    message: '"id" and "type" are mutually exclusive in a resource constraint'
  })
  .refine((c) => !(c.aggregate === true && c.type !== undefined), {
    message: 'aggregate constraints must target a single "id", not a "type" group'
  })

// cpuList shape: comma-separated core IDs and/or integer ranges ("3", "0-1,3") — no
// spaces, signs or floats. Every dash-separated piece of a part must be a plain
// integer; the semantic rules (range right > left, parts ascending and
// non-overlapping) are checked in validateCpuList below.
const CPU_ID_REGEX = /^\d+$/

export function validateCpuList(
  value: string,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void {
  let prevEnd = -1
  let prevPart = ''
  for (const part of value.split(',')) {
    const pieces = part.split('-')
    if (pieces.length > 2 || !pieces.every((p) => CPU_ID_REGEX.test(p))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cpuList "${value}" is invalid: expected comma-separated core IDs and/or integer ranges like "3", "0-1,3" or "0-15,32-47" (spaces, floats and negative values are not allowed)`,
        path
      })
      return
    }
    const isRange = pieces.length === 2
    const [start, end] = isRange
      ? pieces.map(Number)
      : [Number(pieces[0]), Number(pieces[0])]
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cpuList range "${part}": core IDs are too large to be valid CPU IDs`,
        path
      })
      continue
    }
    if (isRange && end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cpuList range "${part}": right side must be strictly greater than left side`,
        path
      })
    }
    if (prevPart && start <= prevEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cpuList ranges "${prevPart}" and "${part}": ranges must be ascending and non-overlapping`,
        path
      })
    }
    if (end > 8192) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cpuList range "${part}": core ID exceeds maximum supported limit`,
        path
      })
    }
    prevEnd = Math.max(prevEnd, end)
    prevPart = part
  }
}

export const ComputeResourceSchema = z
  .object({
    id: z.string(),
    total: z.number().optional(),
    cpuList: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    kind: z.enum(['discrete', 'fungible']).optional(),
    shareable: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    inUse: z.number().optional(),
    init: z.any().optional(),
    platform: z.string().optional(),
    memoryTotal: z.string().optional(),
    driverVersion: z.string().optional(),
    constraints: z.array(ResourceConstraintSchema).optional()
  })
  .superRefine((res, ctx) => {
    if (res.cpuList === undefined) return
    if (res.id !== 'cpu') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Resource "${res.id}": "cpuList" is only valid on the cpu resource`,
        path: ['cpuList']
      })
      return
    }
    if (res.total !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Resource "cpu": specify either "total" or "cpuList", not both`,
        path: ['cpuList']
      })
    }
    validateCpuList(res.cpuList, ctx, ['cpuList'])
  })

export const EnvironmentResourceRefSchema = z
  .object({
    id: z.string(),
    total: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    constraints: z.array(ResourceConstraintSchema).optional()
  })
  .passthrough()

// ── Per-environment capability flags ──────────────────────────────────

const ComputeEnvFeaturesSchema = z
  .object({
    computeJobs: z.boolean().optional().default(true),
    services: z.boolean().optional().default(true)
  })
  .strict() // reject unknown feature keys (catches typos like "computejobs")

// ── Template resource requirements ────────────────────────────────────

const TemplateResourceRequirementSchema = z
  .object({
    id: z.string().optional(),
    kind: z.enum(['discrete', 'fungible']).optional(),
    type: z.string().optional(),
    min: z.number().min(0),
    recommended: z.number().min(0).optional(),
    unit: z.string().optional(),
    description: z.string().optional()
  })
  .strict()
  .refine((r) => r.id !== undefined || r.kind !== undefined, {
    message: 'Each resource requirement must specify either "id" or "kind"'
  })
  .refine((r) => !(r.id !== undefined && r.kind !== undefined), {
    message: '"id" and "kind" are mutually exclusive in a resource requirement'
  })
  .refine((r) => r.recommended === undefined || r.recommended >= r.min, {
    message: '"recommended" must be >= "min"'
  })

// ── Template ──────────────────────────────────────────────────────────

const UserConfigurableEnvVarSchema = z
  .object({
    key: z.string().min(1),
    validation: z.string().optional(),
    sensitive: z.boolean().optional(),
    // Advisory only — the node never rejects a start for a missing value; clients use it to
    // decide whether to prompt (e.g. HF_TOKEN for a gated model).
    required: z.boolean().optional()
  })
  .strict()

// Catalogue classification. Purely descriptive: none of it changes how the container runs,
// it travels to clients through the sanitizer and drives how the entry is presented.
const TemplateIncludedItemSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['model', 'workflow', 'customnode', 'other']),
    sizeGb: z.number().positive().optional(),
    repoId: z.string().min(1).optional(),
    url: z.string().url().optional()
  })
  .strict()

const ServiceTemplateWorkflowSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]+$/, {
      message: 'Workflow id must match [A-Za-z0-9_.-]+'
    }),
    name: z.string().min(1),
    description: z.string().optional(),
    file: z.string().min(1).optional(),
    graph: z.unknown().optional()
  })
  .strict()
  .refine((w) => !!w.file !== !!w.graph, {
    message: 'A workflow must set exactly one of "file" or "graph"'
  })

export const ServiceTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
      message: 'Template id must match [a-z0-9][a-z0-9_-]{0,63}'
    }),
    name: z.string().optional(),
    description: z.string().optional(),
    // Catalogue metadata (all optional; absent `kind` means 'service')
    kind: z.enum(['service', 'bundle']).optional(),
    service: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
        message: '"service" must be a template id matching [a-z0-9][a-z0-9_-]{0,63}'
      })
      .optional(),
    outcome: z.string().min(1).optional(),
    category: z
      .enum([
        'image',
        'video',
        'llm',
        'serving',
        'notebook',
        'embeddings',
        'app',
        'other'
      ])
      .optional(),
    includes: z.array(TemplateIncludedItemSchema).optional(),
    image: z.string().min(1),
    tag: z.string().min(1).optional(),
    checksum: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    dockerfile: z.string().min(1).optional(),
    additionalDockerFiles: z.record(z.string(), z.string()).optional(),
    exposedPorts: z.array(z.number().int().min(1).max(65535)).min(1),
    envVars: z.record(z.string(), z.string()).optional(),
    userConfigurableEnvVars: z.array(UserConfigurableEnvVarSchema).optional(),
    command: z.array(z.string()).optional(),
    commandFile: z.string().min(1).optional(),
    entrypoint: z.array(z.string()).optional(),
    requiredResources: z.array(TemplateResourceRequirementSchema).optional(),
    recommendedResources: z.array(TemplateResourceRequirementSchema).optional(),
    workflows: z.array(ServiceTemplateWorkflowSchema).optional()
  })
  .strict()
  .superRefine((tmpl, ctx) => {
    // Validate each regex in userConfigurableEnvVars.validation compiles
    ;(tmpl.userConfigurableEnvVars ?? []).forEach((uvar, i) => {
      if (uvar.validation) {
        try {
          // eslint-disable-next-line no-new
          new RegExp(uvar.validation)
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `userConfigurableEnvVars[${i}].validation is not a valid regex: "${uvar.validation}"`,
            path: ['userConfigurableEnvVars', i, 'validation']
          })
        }
      }
    })
    // Warn on shell-injection-prone command patterns (security plan #3)
    ;(tmpl.command ?? []).forEach((arg, i) => {
      if (/sh\s+-c|`/.test(arg)) {
        CONFIG_LOGGER.warn(
          `Template "${tmpl.id}" command[${i}] contains shell invocation. ` +
            'This enables injection when userData values are substituted.'
        )
      }
    })

    // Image spec mutual exclusion
    const imageModesSet = [!!tmpl.tag, !!tmpl.checksum, !!tmpl.dockerfile].filter(
      Boolean
    ).length
    if (imageModesSet > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '"tag", "checksum", and "dockerfile" are mutually exclusive — set at most one',
        path: ['image']
      })
    }
    if (tmpl.additionalDockerFiles && !tmpl.dockerfile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"additionalDockerFiles" requires "dockerfile"',
        path: ['additionalDockerFiles']
      })
    }

    // A bundle without a parent id renders as a plain service in clients (they key the
    // grouping off `service`), so a half-declared bundle is a template bug, not a variant.
    if (tmpl.kind === 'bundle' && !tmpl.service) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"service" (the parent template id) is required when kind is "bundle"',
        path: ['service']
      })
    }
    if (tmpl.service && tmpl.kind !== 'bundle') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"service" only applies to a bundle — set kind: "bundle" or drop it',
        path: ['service']
      })
    }

    if (tmpl.command && tmpl.commandFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"command" and "commandFile" are mutually exclusive — set at most one',
        path: ['commandFile']
      })
    }
  })

// ── Per-daemon service config (no templates here) ─────────────────────

export const ServiceOnDemandConfigSchema = z
  .object({
    enabled: z.boolean(),
    nodeHost: z.string().min(1),
    hostPortRange: z
      .tuple([z.number().int().min(1024), z.number().int().max(65535)])
      .refine((r) => !r || r[0] < r[1], {
        message: 'hostPortRange[0] must be less than hostPortRange[1]'
      })
      .optional(),
    minDurationSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(DEFAULT_SERVICE_MIN_DURATION_SECONDS),
    maxDurationSeconds: z
      .number()
      .int()
      .min(60)
      .optional()
      .default(DEFAULT_SERVICE_MAX_DURATION_SECONDS),
    allowImageBuild: z.boolean().optional().default(false)
  })
  .strict()

export const ComputeResourcesPricingInfoSchema = z.object({
  id: z.string(),
  price: z.number()
})

export const ComputeEnvFeesSchema = z.object({
  feeToken: z.string().optional(),
  prices: z.array(ComputeResourcesPricingInfoSchema).optional()
})

export const ComputeEnvironmentFreeOptionsSchema = z.object({
  minJobDuration: z.number().int().optional().default(60),
  maxJobDuration: z.number().int().optional().default(3600),
  maxJobs: z.number().int().optional().default(3),
  resources: z.array(ComputeResourceSchema).optional(),
  access: z
    .object({
      addresses: z.array(z.string()),
      accessLists: z
        .array(z.record(z.string(), z.array(z.string())))
        .nullable()
        .optional()
    })
    .optional(),
  allowImageBuild: z.boolean().optional().default(false)
})

// Config-time schema for the free block — resources are refs, not full ComputeResource objects.
export const C2DEnvironmentFreeConfigSchema = z.object({
  minJobDuration: z.number().int().optional().default(60),
  maxJobDuration: z.number().int().optional().default(3600),
  maxJobs: z.number().int().optional().default(3),
  resources: z.array(EnvironmentResourceRefSchema).optional(),
  access: z
    .object({
      addresses: z.array(z.string()),
      accessLists: z
        .array(z.record(z.string(), z.array(z.string())))
        .nullable()
        .optional()
    })
    .optional(),
  allowImageBuild: z.boolean().optional().default(false)
})

export const C2DEnvironmentConfigSchema = z
  .object({
    id: z.string().optional(),
    description: z.string().optional(),
    storageExpiry: z.number().int().optional().default(604800),
    minJobDuration: z.number().int().optional().default(60),
    maxJobDuration: z.number().int().optional().default(3600),
    // No default: absent means "fall back to this env's minJobDuration", resolved at engine
    // start and clamped up there if it sits below the daemon's serviceOnDemand.minDurationSeconds.
    minServiceDuration: z.number().int().min(0).optional(),
    // No default: absent means "inherit the daemon's serviceOnDemand.maxDurationSeconds",
    // which is resolved at engine start and clamped there if this exceeds it.
    maxServiceDuration: z.number().int().min(1).optional(),
    maxJobs: z.number().int().optional(),
    fees: z.record(z.string(), z.array(ComputeEnvFeesSchema)).optional(),
    access: z
      .object({
        addresses: z.array(z.string()),
        accessLists: z
          .array(z.record(z.string(), z.array(z.string())))
          .nullable()
          .optional()
      })
      .optional(),
    free: C2DEnvironmentFreeConfigSchema.optional(),
    resources: z.array(EnvironmentResourceRefSchema).optional(),
    enableNetwork: z.boolean().optional().default(false),
    features: ComputeEnvFeaturesSchema.optional().default({
      computeJobs: true,
      services: true
    })
  })
  .refine(
    (data) =>
      (data.fees !== undefined && Object.keys(data.fees).length > 0) ||
      (data.free !== undefined && data.free !== null),
    {
      message:
        'Each environment must have either a non-empty "fees" configuration or a "free" configuration'
    }
  )
  .refine((data) => data.storageExpiry >= data.maxJobDuration, {
    message: '"storageExpiry" should be greater than "maxJobDuration"'
  })

export const C2DDockerConfigSchema = z.array(
  z
    .object({
      socketPath: z.string().optional(),
      protocol: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      caPath: z.string().optional(),
      certPath: z.string().optional(),
      keyPath: z.string().optional(),
      imageRetentionDays: z.number().int().min(1).optional().default(7),
      imageCleanupInterval: z.number().int().min(3600).optional().default(86400),
      paymentClaimInterval: z.number().int().min(60).optional().default(3600),
      scanImages: z.boolean().optional().default(false),
      scanImageDBUpdateInterval: z.number().int().min(3600).optional().default(43200),
      resources: z.array(ComputeResourceSchema).optional(),
      environments: z.array(C2DEnvironmentConfigSchema).min(1),
      serviceOnDemand: ServiceOnDemandConfigSchema.optional()
    })
    .superRefine((dockerConfig, ctx) => {
      // Reject old format: env-level resources with init/driverVersion/platform indicate full ComputeResource objects
      // that should have been moved to connection-level resources.
      dockerConfig.environments.forEach((env, envIdx) => {
        ;(env.resources || []).forEach((ref, i) => {
          if (
            (ref as any).init !== undefined ||
            (ref as any).driverVersion !== undefined
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `environments[${envIdx}].resources[${i}]: hardware fields (init, driverVersion, platform, etc.) must be defined at connection level in "resources", not inside an environment. See migration guide.`,
              path: ['environments', envIdx, 'resources', i]
            })
          }
        })
      })

      // Validate env resource refs point to known pool ids.
      // cpu, ram, disk are always valid (auto-detected from host).
      const autoDetected = new Set(['cpu', 'ram', 'disk'])
      const poolIds = new Set([
        ...autoDetected,
        ...(dockerConfig.resources ?? []).map((r) => r.id)
      ])
      dockerConfig.environments.forEach((env, envIdx) => {
        ;(env.resources || []).forEach((ref, i) => {
          if (!poolIds.has(ref.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `environments[${envIdx}].resources[${i}].id "${ref.id}" not found in connection-level resources`,
              path: ['environments', envIdx, 'resources', i, 'id']
            })
          }
        })
      })

      // Connection-level cpu entry must define its size exactly one way: total or cpuList.
      // (Having both is already rejected by ComputeResourceSchema.)
      ;(dockerConfig.resources ?? []).forEach((res, i) => {
        if (res.id === 'cpu' && res.total === undefined && res.cpuList === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `resources[${i}]: the cpu resource must specify either "total" or "cpuList"`,
            path: ['resources', i]
          })
        }
      })

      // cpuList is a connection-level hardware field — reject it in env-level refs,
      // same as init/driverVersion above.
      dockerConfig.environments.forEach((env, envIdx) => {
        ;(env.resources || []).forEach((ref, i) => {
          if ((ref as any).cpuList !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `environments[${envIdx}].resources[${i}]: "cpuList" must be defined at connection level in "resources", not inside an environment`,
              path: ['environments', envIdx, 'resources', i]
            })
          }
        })
      })

      // Reject shareable:true on gpu/fpga type resources — these require exclusive access.
      ;(dockerConfig.resources ?? []).forEach((res, i) => {
        if (res.shareable === true && (res.type === 'gpu' || res.type === 'fpga')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Resource "${res.id}": shareable:true is not allowed for type "${res.type}" — GPUs and FPGAs require exclusive access per job`,
            path: ['resources', i]
          })
        }
      })

      // Warn (not error) if shareable:true on a fungible resource — it has no effect.
      ;(dockerConfig.resources ?? []).forEach((res) => {
        if (res.shareable === true && res.kind === 'fungible') {
          CONFIG_LOGGER.warn(
            `Resource "${res.id}": shareable:true has no effect on fungible resources`
          )
        }
      })
    })
)

export const C2DClusterInfoSchema = z.object({
  type: z.nativeEnum(C2DClusterType),
  hash: z.string(),
  connection: z.any().optional(),
  tempFolder: z.string().optional()
})

export const OceanNodeP2PConfigSchema = z.object({
  bootstrapNodes: jsonFromString(z.array(z.string())).default([
    ...DEFAULT_BOOTSTRAP_ADDRESSES
  ]),
  bootstrapTimeout: z.coerce.number().optional().default(10000),
  bootstrapTagName: z.string().optional().default('bootstrap'),
  bootstrapTagValue: z.coerce.number().optional().default(50),
  bootstrapTTL: z.coerce.number().optional(),
  enableIPV4: booleanFromString.optional().default(true),
  enableIPV6: booleanFromString.optional().default(true),
  ipV4BindAddress: z.string().nullable().optional().default('0.0.0.0'),
  ipV4BindTcpPort: z.coerce.number().nullable().optional().default(9000),
  ipV4BindWsPort: z.coerce.number().nullable().optional().default(9001),
  ipV4BindWssPort: z.coerce.number().nullable().optional().default(9005),
  ipV6BindAddress: z.string().nullable().optional().default('::'),
  ipV6BindTcpPort: z.coerce.number().nullable().optional().default(9002),
  ipV6BindWsPort: z.coerce.number().nullable().optional().default(9003),
  dhtMaxInboundStreams: z.coerce.number().optional().default(500),
  dhtMaxOutboundStreams: z.coerce.number().optional().default(500),
  dhtFilter: z
    .union([z.nativeEnum(dhtFilterMethod), z.string(), z.number(), z.null()])
    .transform((v) => {
      if (v === null) {
        return dhtFilterMethod.filterNone
      }
      // The readable enum name, e.g. from `config.json` or a `P2P_DHT_FILTER=filterPrivate`
      // env var - match it directly, before ever reaching for parseInt.
      if (
        typeof v === 'string' &&
        (Object.values(dhtFilterMethod) as string[]).includes(v)
      ) {
        return v as dhtFilterMethod
      }
      // Legacy numeric form, string or number: 0 = filterNone, 1 = filterPrivate,
      // 2 = filterPublic. Only reach for parseInt when the string actually looks numeric,
      // so a misspelled enum name (e.g. "filterPrivatte") can't be coerced into NaN and
      // silently misread as a filter level.
      const isNumericString = typeof v === 'string' && /^-?\d+$/.test(v.trim())
      if (typeof v === 'number' || isNumericString) {
        switch (typeof v === 'string' ? parseInt(v, 10) : v) {
          case 0:
            return dhtFilterMethod.filterNone
          case 1:
            return dhtFilterMethod.filterPrivate
          case 2:
            return dhtFilterMethod.filterPublic
        }
      }
      // Unrecognised value (bad enum name, out-of-range number, or non-numeric junk).
      // Fall back to the documented default rather than the previous behaviour of
      // silently landing on filterNone - the least safe choice for a typo on a knob
      // that controls whether private addresses get stripped from the DHT.
      CONFIG_LOGGER.warn(
        `Unrecognised dhtFilter value "${v}", falling back to the default (${dhtFilterMethod.filterPrivate})`
      )
      return dhtFilterMethod.filterPrivate
    })
    .optional()
    // Filtering private addresses out of the DHT is the highest-fanout code path in the
    // network - it runs on every peer this node's kad-dht learns about, not just the ones it
    // dials. filterPrivate is also kad-dht's own upstream default (removePrivateAddressesMapper);
    // ocean-node was overriding it down to filterNone. announcePrivateIp still forces
    // passthroughMapper back on for local/test networks - see dhtOptions below.
    .default(dhtFilterMethod.filterPrivate),
  mDNSInterval: z.coerce.number().optional().default(20e3),
  // Passing `clientMode` to kad-dht at all - even `false` - suppresses the listener that
  // promotes this node to a DHT server once it has a public address (see dhtOptions below).
  // This only forces server mode for an operator who already knows they are reachable.
  dhtForceServer: booleanFromString.optional().default(false),
  connectionsMaxParallelDials: z.coerce.number().optional().default(50),
  connectionsDialTimeout: z.coerce.number().optional().default(15e3),
  // libp2p's own default; not previously exposed as config.
  maxDialQueueLength: z.coerce.number().optional().default(500),
  upnp: booleanFromString.optional().default(true),
  autoNat: booleanFromString.optional().default(true),
  enableCircuitRelayServer: booleanFromString.optional().default(false),
  enableCircuitRelayClient: booleanFromString.optional().default(false),
  circuitRelays: z.coerce.number().optional().default(0),
  announcePrivateIp: booleanFromString.optional().default(false),
  announceAddresses: jsonFromString(z.array(z.string())).optional().default([]),
  filterAnnouncedAddresses: jsonFromString(z.array(z.string()))
    .optional()
    .default([...DEFAULT_FILTER_ANNOUNCED_ADDRESSES]),
  minConnections: z.coerce.number().optional().default(1),
  maxConnections: z.coerce.number().optional().default(300),
  autoDialPeerRetryThreshold: z.coerce.number().optional().default(120000),
  autoDialConcurrency: z.coerce.number().optional().default(5),
  // The dial budget is spent per address before the transport check runs, so even an
  // instantly-skipped address counts against it - and a single bootstrap peer now has
  // around 6 addresses (tcp/ws/wss x v4/v6).
  maxPeerAddrsToDial: z.coerce.number().optional().default(30),
  autoDialInterval: z.coerce.number().optional().default(5000),
  enableNetworkStats: booleanFromString.optional().default(false),
  // P2P timeout / attempt budgets. The defaults are imported from
  // src/components/P2P/timeouts.ts so there is exactly one source of truth - the values
  // values shared with ocean.js and ocean-node-bootstrap are marked there.
  // Declaring them here makes them real, validated, documented configuration keys that
  // ENVIRONMENT_VARIABLES sync can find. See the config seam note in
  // timeouts.ts: consumption is via the P2P_* environment variables, because the typed
  // OceanNodeP2PConfig interface lives in src/@types/OceanNode.ts.
  findPeerTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.findPeerMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  findProvidersTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.findProvidersMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  streamIdleTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.streamIdleMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // ceiling on a whole response body, on top of the per-frame idle budget above. Read by
  // `timeouts.ts` from `P2P_STREAM_BODY_TIMEOUT_MS`, which `ENV_TO_CONFIG_MAPPING` maps here,
  // so an env override moves the validated config and the running code together.
  streamBodyTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.streamBodyMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  sendToResolveTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.sendToResolveMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  sendToDialTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.sendToDialMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  sendToStreamTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.sendToStreamMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // floored at 1 but not capped, so a fat-fingered value multiplied the whole sendTo
  // budget. The cap is shared with the getter, hence the same constant. A count, not a
  // duration, so it keeps the floor of 1 rather than the millisecond floor.
  sendToMaxAttempts: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.sendToMaxAttempts,
    SENDTO_MAX_ATTEMPTS_CAP
  ),
  // overall deadline for one sendTo setup phase. Mapped from `P2P_SENDTO_TOTAL_MS` in
  // `ENV_TO_CONFIG_MAPPING`, so the validated config and `timeouts.ts` - which reads
  // `process.env` directly - always report the same number.
  sendToTotalTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.sendToTotalMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  advertiseTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.advertiseMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  peerStoreGetTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.peerStoreGetMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  discoveryDialTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.discoveryDialMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // also a count rather than a duration: 1 inbound stream is a valid, if austere, setting.
  commandMaxInboundStreams: p2pBudget(P2P_TIMEOUT_DEFAULTS.commandMaxInboundStreams),
  findDdoTimeout: p2pBudget(P2P_TIMEOUT_DEFAULTS.findDdoMs, undefined, P2P_BUDGET_MIN_MS),
  // Per-provider budget inside FindDDO. Providers are queried concurrently and the first
  // legitimate answer wins, so this bounds one branch rather than dividing the overall
  // deadline. It replaces the fixed inter-provider back-off, which no longer exists: nothing
  // sleeps between providers now, so there is no interval left to configure.
  findDdoProviderTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.findDdoProviderMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // How long a "no provider had this DDO" answer is remembered, to blunt a hot re-query loop.
  ddoNotFoundCacheTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.ddoNotFoundCacheMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // Lifetimes of the app-level peer-address cache and of its negative half. Both are short by
  // design and neither is load-bearing for correctness - a stale entry is corrected by
  // invalidation on dial failure.
  resolveCacheTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.resolveCacheMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  resolveNegativeCacheTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.resolveNegativeCacheMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // Ceiling on concurrent outbound sendTo calls. A count, so it keeps the implicit floor of 1
  // rather than the millisecond floor, and it is clamped to a cap for the same reason
  // sendToMaxAttempts is - see the constants in timeouts.ts.
  sendToMaxConcurrency: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.sendToMaxConcurrency,
    SENDTO_MAX_CONCURRENCY_CAP
  ),
  // Routing-table size at which this node reports its P2P interface ready. Also a count.
  readyMinRoutingPeers: p2pBudget(P2P_TIMEOUT_DEFAULTS.dhtReadyMinPeers),
  // Delay before kad-dht's first self-query, the one that populates the routing table. Raised
  // above kad-dht's own 1s so it runs after bootstrap connections exist rather than before.
  initialQuerySelfTimeout: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.initialQuerySelfMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  // How long the peer store keeps addresses, and how long it keeps a peer record. Both
  // default to the 48h lifetime of a DHT provider record, against libp2p's own 1h and 6h, so
  // a provider record and the addresses it points at stop being valid at the same moment.
  // `peerStoreAgeLimits()` in timeouts.ts holds them to `maxPeerAge >= maxAddressAge` at the
  // point they are handed to libp2p; this half only validates each value on its own.
  peerStoreMaxAddressAge: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.peerStoreMaxAddressAgeMs,
    undefined,
    P2P_BUDGET_MIN_MS
  ),
  peerStoreMaxPeerAge: p2pBudget(
    P2P_TIMEOUT_DEFAULTS.peerStoreMaxPeerAgeMs,
    undefined,
    P2P_BUDGET_MIN_MS
  )
})

const addressArrayFromString = jsonFromString(z.array(z.string())).transform(
  (addresses) => {
    if (!Array.isArray(addresses)) return []
    try {
      return addresses.map((addr) => getAddress(addr))
    } catch (error) {
      CONFIG_LOGGER.error(`Invalid address in list: ${error.message}`)
      return []
    }
  }
)

export const OceanNodeConfigSchema = z
  .object({
    dockerComputeEnvironments: jsonFromString(C2DDockerConfigSchema)
      .optional()
      .default([]),

    serviceTemplatesPath: z.string().optional().default('databases/serviceTemplates/'),

    dockerRegistrysAuth: jsonFromString(DockerRegistrysSchema).optional().default({}),

    authorizedDecrypters: addressArrayFromString.optional().default([]),
    authorizedDecryptersList: jsonFromString(AccessListContractSchema).optional(),

    allowedValidators: addressArrayFromString.optional().default([]),
    allowedValidatorsList: jsonFromString(AccessListContractSchema).optional(),

    authorizedPublishers: addressArrayFromString.optional().default([]),
    authorizedPublishersList: jsonFromString(AccessListContractSchema).optional(),

    keys: OceanNodeConfigKeysSchema.optional(),

    INTERFACES: z.string().optional(),
    hasP2P: booleanFromString.optional().default(true),
    hasHttp: booleanFromString.optional().default(true),
    enableBenchmark: booleanFromString.optional().default(false),

    p2pConfig: OceanNodeP2PConfigSchema.nullable().optional(),
    hasIndexer: booleanFromString.default(true),

    DB_URL: z.string().optional(),
    DB_USERNAME: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_TYPE: z.string().optional(),
    dbConfig: OceanNodeDBConfigSchema.optional(),
    // Accept either an object (config file) or a JSON string (env var `PERSISTENT_STORAGE`),
    // and validate the parsed value against the PersistentStorage schema.
    persistentStorage: z
      .preprocess((val) => {
        if (val === undefined || val === null) return val
        if (typeof val === 'string') {
          const tryParse = (s: string) => {
            try {
              return JSON.parse(s)
            } catch {
              return undefined
            }
          }

          // 1) Normal JSON string
          const parsed = tryParse(val)
          if (parsed !== undefined) {
            // 2) Handle double-encoded JSON (e.g. "\"{...}\"")
            if (typeof parsed === 'string') {
              const parsedTwice = tryParse(parsed)
              if (parsedTwice !== undefined) return parsedTwice
            }
            return parsed
          }

          // 3) Common docker-compose/shell mistake: single quotes inside JSON
          const normalized = val.replace(/'/g, '"')
          const parsedNormalized = tryParse(normalized)
          if (parsedNormalized !== undefined) return parsedNormalized

          return val
        }
        return val
      }, PersistentStorageConfigSchema)
      .optional(),

    FEE_AMOUNT: z.string().optional(),
    FEE_TOKENS: z.string().optional(),
    feeStrategy: FeeStrategySchema.optional(),

    httpPort: z.coerce.number().optional().default(3000),
    rateLimit: z.coerce.number().optional().default(DEFAULT_RATE_LIMIT_PER_MINUTE),

    // Startup database-init retry knobs. int().min(1) is load-bearing, not decoration:
    // maxAttempts of 0 would skip Database.init() altogether and boot the node with no
    // database, and a 0 delay would turn the backoff into a hot loop. A non-numeric or
    // out-of-range value fails validation, so the node refuses to start instead of silently
    // running with retrying disabled.
    dbInitMaxAttempts: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .default(DEFAULT_DB_INIT_MAX_ATTEMPTS),
    dbInitRetryDelay: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .default(DEFAULT_DB_INIT_RETRY_DELAY),
    dbInitMaxRetryDelay: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .default(DEFAULT_DB_INIT_MAX_RETRY_DELAY),

    ipfsGateway: z.string().nullable().optional(),
    arweaveGateway: z.string().nullable().optional(),

    supportedNetworks: jsonFromString(RPCSSchema).optional(),

    claimDurationTimeout: z.coerce.number().default(3600),
    indexingNetworks: z
      .union([jsonFromString(RPCSSchema), z.array(z.union([z.string(), z.number()]))])
      .optional(),

    c2dClusters: z.array(C2DClusterInfoSchema).optional(),
    accountPurgatoryUrl: z
      .string()
      .nullable()
      .refine((url) => !url || isValidUrl(url), {
        message: 'accountPurgatoryUrl must be a valid URL'
      }),
    assetPurgatoryUrl: z
      .string()
      .nullable()
      .refine((url) => !url || isValidUrl(url), {
        message: 'assetPurgatoryUrl must be a valid URL'
      }),
    allowedAdmins: addressArrayFromString.optional(),
    allowedAdminsList: jsonFromString(AccessListContractSchema).optional(),

    codeHash: z.string().optional(),
    maxConnections: z.coerce.number().optional(),
    denyList: jsonFromString(DenyListSchema).optional().default({ peers: [], ips: [] }),
    unsafeURLs: jsonFromString(z.array(z.string()))
      .optional()
      .default([...DEFAULT_UNSAFE_URLS]),
    isBootstrap: booleanFromString.optional().default(false),
    validateUnsignedDDO: booleanFromString.optional().default(true),
    jwtSecret: z.string(),
    httpCertPath: z.string().optional(),
    httpKeyPath: z.string().optional()
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (!data.hasHttp && !data.hasP2P) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one interface (HTTP or P2P) must be enabled',
        path: ['hasHttp']
      })
    }

    if (data.hasP2P && !data.p2pConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'P2P configuration is required when hasP2P is true',
        path: ['p2pConfig']
      })
    }
  })

export type OceanNodeConfigParsed = z.infer<typeof OceanNodeConfigSchema>
