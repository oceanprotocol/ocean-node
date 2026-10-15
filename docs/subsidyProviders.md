# Subsidy Providers

**Subsidy Providers** let a third party cover part (or all) of a consumer's payment for a paid
compute job or an on-demand service — and optionally pay the node a bonus. A subsidy provider is an
on-chain contract that holds a budget and decides, per request, how much to contribute. The Ocean
Node simply **names** one or more providers when it locks and claims the consumer's payment in
escrow; the escrow and the provider contracts do the rest.

This unlocks flows like **zero-deposit onboarding** (a fully-sponsored job where the consumer pays
nothing), enterprise/university subsidies, promotional discounts, grants, and loyalty bonuses —
without changing how jobs are published or run.

- Operator configuration: [`env.md`](env.md) (`SUBSIDY_PROVIDERS`, `SUBSIDY_PROVIDER_FILTER`).
- Per-request field + event queries: [`API.md`](API.md) (`subsidyProviders`, `getEscrowEvents`).

---

## How it works

Paid compute and services settle through the Ocean **Escrow** contract. The node is the **payee**:
it creates a **lock** on the consumer's funds up front, runs the work, then **claims** the lock when
the work is done (or cancels it on failure). Subsidy providers plug into that lifecycle at two
points, and the node hands the **same provider list** to both the lock and the claim so they always
agree.

```
consumer deposits + authorizes ──►  node createLock([providers])  ──►  work runs  ──►  node claimLock([providers])
                                     │ (PREPAID: provider pre-funds)                   │ (REFUND: provider reimburses)
                                     └─ escrow emits LockSponsored                     └─ escrow emits Subsidized
```

A provider only contributes if, for that request, it is funded and the caller passes its gates
(see [Access-list gating](#access-list-gating)). Otherwise the lock/claim is simply payer-funded.

---

## Two modes: prepaid vs refund (and zero-deposit)

Every subsidy provider advertises which mode(s) it honours through its own `subsidyModeConfig()`
(owner-set via `setSubsidyMode`). This is a **provider** setting — the node does not choose the
mode; it only names the provider.

| Mode value | Name | When the subsidy applies | Escrow event |
|---|---|---|---|
| `0` | `BOTH` | both legs active (default) | `LockSponsored` and/or `Subsidized` |
| `1` | `REFUND_ONLY` | **claim** time — provider reimburses after the work ran | `Subsidized` |
| `2` | `PREPAID_ONLY` | **lock** time — provider pre-funds the lock up front | `LockSponsored` |

**REFUND (reimbursement).** The consumer still fronts the funds (they must have deposited and
authorized enough). At claim, the provider reimburses the sponsored portion. This is the classic
"cashback" model — the job is paid normally, then the subsidy flows back.

**PREPAID (lock-time sponsorship).** The provider's tokens are pulled into a non-withdrawable
sponsored bucket that backs the lock **at creation time**. At claim, the node is paid from that
bucket first.

**Zero-deposit onboarding.** Because a prepaid lock is backed by the provider's bucket, a
**fully-sponsored** lock needs **no consumer deposit at all**. The consumer authorizes the node with
a `maxLockedAmount` of `0` ("sponsored-only — the node can never touch my own funds"), deposits
nothing, and the provider covers 100% of the cost. On the node side this is why the sponsored-lock
pre-checks are relaxed: a sponsored request is not rejected for an empty balance (service start and
paid compute both support this).

**Bonus.** A provider can also pay the **node** a bonus on top of the subsidy (surfaced as
`bonusAmount` on the `Subsidized` event, and per-mode via the provider's `quoteSubsidyModes`). This
is how loyalty / incentive programs reward node operators for routing work through a provider.

---

## Configuring your node (operator)

Two environment variables (full details in [`env.md`](env.md)):

- **`SUBSIDY_PROVIDERS`** — a per-chain map of provider contract addresses the node uses by default,
  e.g. `{"8453": ["0x…"]}`. The node passes these to the escrow at **lock and claim** time.
- **`SUBSIDY_PROVIDER_FILTER`** — `true`/`false` (default `false`). When ON, a consumer-supplied
  provider list may only name addresses already in `SUBSIDY_PROVIDERS` for that chain; anything else
  is rejected (HTTP 400).

> ⚠️ **Open-program warning.** With the filter OFF, a consumer may name **any** funded provider —
> including one they have no relationship with — and have your node draw against it. An OFF filter
> therefore runs an **open, sybil-drainable** program, bounded only by the provider's funded balance
> and caps. The node logs a startup **WARN** when `SUBSIDY_PROVIDERS` is set while the filter is off.
> Turn the filter **ON** to restrict callers to your own providers, and fund/cap providers
> accordingly.

The node does not deploy or own providers; it references existing provider contracts. Operators who
want to run their own program deploy a provider (e.g. one of the reference implementations below),
fund it, configure it, and list its address in `SUBSIDY_PROVIDERS`.

---

## Choosing providers per request (consumer)

`startCompute` (paid), `serviceStart`, and `serviceExtend` accept an optional top-level
`subsidyProviders` array (ignored for free compute). It overrides the node's defaults for that one
request:

| Value | Meaning |
|---|---|
| omitted / `undefined` | use the node's configured `SUBSIDY_PROVIDERS` for the chain |
| `[]` | no providers — plain payer-funded |
| `["0x…", …]` | use exactly these addresses |

Addresses must be valid EVM addresses (checksummed on the way through); duplicates are collapsed; at
most **10 unique** providers may apply to one lock (the escrow's `maxSponsorsPerLock()`), and more is
rejected with HTTP 400. When `SUBSIDY_PROVIDER_FILTER` is ON, every named address must be in the
node's whitelist for the chain. See the per-request `subsidyProviders` field in [`API.md`](API.md).

---

## Reference provider implementations

Two providers ship with the Ocean contracts; both implement the standard interfaces (so they are
discoverable via ERC-165) and both support REFUND, PREPAID, or BOTH.

- **`OPFSubsidyProvider`** — a **rolling-budget** program. The owner configures per-token limits with
  `setTokenLimits(token, pctBps, daily, weekly, monthly, enabled)` (a percentage cap plus
  daily/weekly/monthly spend windows) and funds the contract with tokens. Good for ongoing programs:
  promos, percentage discounts, regional growth funds.
- **`OneTimeSubsidyProvider`** — a **per-user credit** program. The owner configures
  `setTokenConfig(token, pctBps, defaultCredit, enabled)` (a one-time credit every user gets) and/or
  grants explicit credits with `setUserCredit` / `setUserCredits`, and can reset users. Good for
  bounded, per-person grants: onboarding credits, hackathons, student programs.

Common owner controls on both: `setAllowedJobTypes([...])` (which job types are subsidized),
`setAuthorizedEscrow(escrow, true)` (authorize the escrow to call it), `pause()` / `unpause()`,
`setSubsidyMode(mode)`, `withdrawTokens` / `withdrawAllTokens`, and the two access lists below.

### Access-list gating

Each provider applies **two** gates on every subsidy decision — a **user** access list (the payer)
and a **node** access list (the payee) — via `setUserAccessList` / `setNodeAccessList`. A **zero
address = open to everyone**, so an operator can run any of:

- **Open** — both lists unset: anyone may draw (bounded by funding/caps; combine with
  `SUBSIDY_PROVIDER_FILTER` on the node side).
- **User-gated** — only listed payers (e.g. employees, students, members).
- **Node-gated** — only listed nodes (e.g. your own fleet, partner nodes).
- **Fully-gated** — both.

---

## Events & observability

The node's indexer records these escrow events (query them via `getEscrowEvents`, see
[`API.md`](API.md)):

| Event | Emitted when | Carries |
|---|---|---|
| `LockSponsored` | a provider pre-funds a lock (PREPAID) | `provider`, `amount` |
| `Subsidized` | a provider reimburses at claim (REFUND) | `provider`, `subsidyAmount`, `bonusAmount` |
| `SponsorRefunded` | unused prepaid tokens returned (partial claim / expiry / shrink) | `provider`, `amount`, `reclaimable` |

Accounting note for anyone reading escrow state directly: under Escrow v2, `getUserFunds().locked`
and an authorization's `currentLockedAmount` track only the **payer-funded** portion `P = L − S`
(not the gross lock `L`); the sponsored portion `S` lives in a separate bucket
(`getSponsoredTotal(token)`, or `getSponsorship(payee, payer, jobId)` per lock).

---

## Use cases

Each of these is just a provider configured a particular way and named in `SUBSIDY_PROVIDERS` (or
supplied per request):

| Use case | Shape |
|---|---|
| **Enterprise subsidizes its employees' compute** | OPF, **user-gated** to the employee access list; REFUND or PREPAID. |
| **Enterprise subsidizes its own servers/nodes** | OPF, **node-gated** to the company's node access list. |
| **University subsidizes students** | OneTime per-student credit (or OPF user-gated to a student list). |
| **Node owner's "Half-off Mondays" promo** | OPF with `pctBps` ≈ 5000 (50%), funded/limited for the promo window. |
| **New-user onboarding credit (first N jobs free)** | OneTime, **PREPAID** for zero-deposit, `defaultCredit` sized to N jobs. |
| **Grant / research funder as a bounded escrow** | Fund a provider with a fixed budget; subsidy stops when the pool drains. |
| **Node loyalty via `bonusAmount`** | Provider pays the node a bonus on top of the subsidy to reward routing. |
| **Tiered membership (Bronze/Silver/Gold)** | Per-user credits/limits (`setUserCredit` tiers) behind a member access list. |
| **Regional / ecosystem growth fund** | Open or region-gated OPF funded by the ecosystem; cap via windows + node filter. |
| **Token-preference incentive** | Per-token limits (`setTokenLimits`) that subsidize only the preferred token. |
| **Sponsor-a-hackathon / event mode** | OneTime `setUserCredits` to participant addresses, time-boxed by funding. |

> Pairing tip: for **open** programs keep `SUBSIDY_PROVIDER_FILTER=true` on the nodes you want to
> favour and fund/cap the provider conservatively; for **gated** programs the provider's access
> lists do the restriction and the node filter is optional.

---

## See also

- [`env.md`](env.md) — `SUBSIDY_PROVIDERS`, `SUBSIDY_PROVIDER_FILTER`.
- [`API.md`](API.md) — per-request `subsidyProviders`, `getEscrowEvents`.
- [`compute.md`](compute.md) — paid compute environments.
- [`services.md`](services.md) — on-demand services.
