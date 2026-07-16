# Compute (Compute-to-Data) Configuration

The single reference for configuring your node's Docker compute environments — from
node-wide resource declaration, through GPU setup, down to per-environment constraints and
pricing. It covers the `DOCKER_COMPUTE_ENVIRONMENTS` variable (or `dockerComputeEnvironments`
config key), the two-level resource model, GPU vendors (NVIDIA/AMD/Intel), resource
constraints, availability gating, and the fee structure.

> On-demand **services** run on the same compute environments and draw from the same
> resource pool described here — see [services.md](services.md).

## Contents

1. [Overview](#overview)
2. [Where to configure](#where-to-configure)
3. [Configuration layout](#configuration-layout)
4. [Node-wide (connection-level) resources](#node-wide-connection-level-resources)
5. [Configuring GPUs](#configuring-gpus)
6. [Environment-level resource refs](#environment-level-resource-refs)
7. [Resource constraints](#resource-constraints)
8. [Availability & tracking](#availability--tracking)
9. [Pricing](#pricing)
10. [Free tier](#free-tier)
11. [Verify](#verify)
12. [Checklist](#checklist)
13. [Full example](#full-example)

---

## Overview

- **Configuration**: Define compute environments via the `DOCKER_COMPUTE_ENVIRONMENTS`
  environment variable (JSON) or via `config.json` under `dockerComputeEnvironments`.
- **Two-level layout**: Resources are defined once at the **Docker-connection level**
  (`socketPath`) and **referenced** by each environment. This lets multiple environments
  share the same hardware (e.g. both a paid and a free environment can use the same GPU).
- **Auto-detection**: `cpu` and `ram` are automatically detected from the host at startup.
  `disk` is measured via `statfs`. You only need to declare them in `resources` if you want
  to cap/override the detected value.
- **Resources**: The connection-level `resources` array holds full hardware definitions.
  Each environment's `resources` array holds lightweight refs
  (`{ id, total?, min?, max?, constraints? }`) pointing to those pool entries.
- **Dual-gate tracking** (fungible resources like CPU/RAM/disk): Gate 1 enforces the
  per-environment ceiling; Gate 2 enforces the engine-wide physical pool ceiling. Both must
  pass for a job to be admitted.
- **Pricing**: For each chain and fee token, you set a `price` per resource. Cost is
  **price × amount × duration (in minutes, rounded up)**.
- **Free tier**: Environments can have a `free` block that permits jobs with no payment, but
  with tighter resource limits.
- **Image building**: Free jobs cannot build images (Dockerfiles are not allowed). For paid
  jobs, image build time counts toward billable duration.

---

## Where to configure

1. **Environment variable**
   Set `DOCKER_COMPUTE_ENVIRONMENTS` to a JSON string (array of Docker-connection objects):
   `export DOCKER_COMPUTE_ENVIRONMENTS='[{"socketPath":"/var/run/docker.sock",...}]'`

2. **Config file**
   Put the same array in your JSON config under the key `dockerComputeEnvironments`, and
   point the node to that file (e.g. via `CONFIG_PATH`).

If both are set, the environment variable overrides the config. See [env.md](env.md) for all
available fields.

---

## Configuration layout

```
DOCKER_COMPUTE_ENVIRONMENTS
└── [ Docker connection ]          ← socketPath, resources[], environments[]
    ├── resources[]                ← full hardware definitions (CPU, RAM, disk, GPU, …)
    │   ├── { id: "cpu",  total: 6 }          (optional: caps auto-detected value)
    │   ├── { id: "ram",  total: 28 }          (optional: caps auto-detected value)
    │   ├── { id: "disk", total: 80 }          (optional: caps auto-detected value)
    │   └── { id: "gpu0", kind: "discrete", … } (required for custom hardware)
    └── environments[]             ← one or more compute environments
        └── { id, fees, resources[], free? }
            └── resources[]        ← lightweight refs to the pool above
                ├── { id: "cpu",  total: 4, min: 1, max: 4, constraints: [...] }
                ├── { id: "ram",  total: 16, min: 1, max: 8 }
                ├── { id: "disk", max: 20 }
                └── { id: "gpu0" }
```

`cpu`, `ram`, and `disk` are **auto-detected** at startup — you do not need to declare them
in the connection-level `resources` array. Include them only to cap the detected value (e.g.
limit an 8-core host to 6 cores for compute). Custom hardware (GPUs, NICs) must always be
declared.

---

## Node-wide (connection-level) resources

These fields go in the `resources` array at the Docker-connection level:

| Field | Description |
|---|---|
| `id` | Unique identifier used in env refs and `fees.prices[].id` (e.g. `"cpu"`, `"gpu0"`) |
| `total` | Maximum units available in the pool. For `cpu`/`ram`/`disk`, caps the auto-detected value. |
| `kind` | `"fungible"` (CPU, RAM, disk — interchangeable units) or `"discrete"` (GPU, FPGA — named device). Auto-inferred if omitted: `"discrete"` when `init` is present, `"fungible"` otherwise. |
| `shareable` | `discrete` only. `true` → multiple jobs may use the device simultaneously (e.g. NIC, TPM). `false` (default) → exclusive per job (GPU, FPGA). |
| `min` | Minimum units per job request |
| `max` | Maximum units per job request (defaults to `total`) |
| `type` | Hint string used for grouping and display: `"cpu"`, `"ram"`, `"disk"`, `"gpu"`, `"fpga"`, … Group constraints (see below) match on this. |
| `description` | Human-readable label shown in `getComputeEnvironments` |
| `driverVersion` | GPU driver version string |
| `memoryTotal` | GPU VRAM string (e.g. `"40960 MiB"`) |
| `platform` | GPU vendor: `"nvidia"`, `"amd"`, `"intel"` |
| `init` | Docker container configuration (`deviceRequests` for NVIDIA, `advanced` for AMD/Intel). Makes `kind` default to `"discrete"`. |
| `constraints` | Companion resource requirements — see [Resource constraints](#resource-constraints). |

### CPU pinning with `cpuList`

For the `cpu` resource only, you may pin jobs to specific host cores with `cpuList` instead
of `total` (the two are mutually exclusive). It is a cpuset string of ascending,
non-overlapping core IDs and/or ranges: `"3"`, `"0-1,3"`, `"0-15,32-47"` (no spaces, floats,
or negatives). The effective `total` becomes the number of expanded cores, and every id is
validated against the host's CPU count at startup.

---

## Configuring GPUs

Supporting GPUs comes down to:

- define each GPU as a **named resource at the connection level** (same level as `socketPath`),
- pass Docker device args inside each GPU's `init` block,
- reference the GPU by `id` in the environment's `resources` list,
- set a price for each GPU in the environment's `fees` (see [Pricing](#pricing)).

### Key rules

- Each physical GPU is its own resource with a unique `id` and exactly **one** `DeviceID`.
- `kind: "discrete"` (non-fungible): only one job at a time can use the device. This is the
  default when `init` is present.
- `cpu`, `ram`, and `disk` are **auto-detected** — you do not need to declare them unless you
  want to cap their totals.
- Environment `resources` are **lightweight refs** (`id` + optional
  `total`/`min`/`max`/`constraints`). Hardware details (`init`, `driverVersion`, `platform`,
  etc.) live only at connection level.

> **Security note**: `init.advanced` entries (`Binds`, `CapAdd`, `Devices`, `SecurityOpt`)
> apply to every job in every environment that references the resource. Review them carefully
> before adding to production configs.

### NVIDIA GPU

Install the [NVIDIA CUDA drivers](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)
and [NVIDIA container toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

Get the GPU UUID:

```bash
nvidia-smi --query-gpu=name,uuid,driver_version,memory.total --format=csv
# NVIDIA GeForce GTX 1060 3GB, GPU-294c6802-bb2f-fedb-f9e0-a26b9142dd81, 570.195.03, 3072 MiB
```

Define the GPU at the **connection level** with `kind: "discrete"` and a single `DeviceID`.
The environment references it by `id`.

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [
      {
        "id": "gpu0",
        "kind": "discrete",
        "type": "gpu",
        "total": 1,
        "description": "NVIDIA GeForce GTX 1060 3GB",
        "platform": "nvidia",
        "driverVersion": "570.195.03",
        "memoryTotal": "3072 MiB",
        "init": {
          "deviceRequests": {
            "Driver": "nvidia",
            "DeviceIDs": ["GPU-294c6802-bb2f-fedb-f9e0-a26b9142dd81"],
            "Capabilities": [["gpu"]]
          }
        },
        "constraints": [{ "id": "ram", "min": 2 }, { "id": "cpu", "min": 1 }]
      }
    ],
    "environments": [
      {
        "id": "gpu-env",
        "description": "NVIDIA GPU environment",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "resources": [
          { "id": "cpu", "min": 1, "max": 4 },
          { "id": "ram", "min": 1, "max": 8 },
          { "id": "disk", "min": 1, "max": 50 },
          { "id": "gpu0" }
        ],
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [{ "id": "cpu", "price": 1 }, { "id": "gpu0", "price": 3 }]
            }
          ]
        }
      }
    ]
  }
]
```

### AMD Radeon (ROCm)

Install [ROCm](https://rocm.docs.amd.com/projects/radeon/en/latest/docs/install/wsl/install-radeon.html),
then define the GPU with `init.advanced` instead of `deviceRequests`:

```json
{
  "id": "gpu0",
  "kind": "discrete",
  "type": "gpu",
  "total": 1,
  "description": "AMD Radeon RX 9070 XT",
  "driverVersion": "26.2.2",
  "memoryTotal": "16384 MiB",
  "init": {
    "advanced": {
      "IpcMode": "host",
      "ShmSize": 8589934592,
      "CapAdd": ["SYS_PTRACE"],
      "Devices": ["/dev/dxg", "/dev/dri/card0"],
      "Binds": [
        "/usr/lib/wsl/lib/libdxcore.so:/usr/lib/libdxcore.so",
        "/opt/rocm/lib/libhsa-runtime64.so.1:/opt/rocm/lib/libhsa-runtime64.so.1"
      ],
      "SecurityOpt": { "seccomp": "unconfined" }
    }
  },
  "constraints": [{ "id": "ram", "min": 4 }, { "id": "cpu", "min": 2 }]
}
```

### Intel Arc

Install the [Intel GPU drivers](https://dgpu-docs.intel.com/driver/installation.html), then:

```json
{
  "id": "gpu0",
  "kind": "discrete",
  "type": "gpu",
  "total": 1,
  "description": "Intel Arc A770M Graphics",
  "driverVersion": "32.0.101.8531",
  "memoryTotal": "16384 MiB",
  "init": {
    "advanced": {
      "Devices": ["/dev/dri/renderD128", "/dev/dri/card0"],
      "GroupAdd": ["video", "render"],
      "CapAdd": ["SYS_ADMIN"]
    }
  },
  "constraints": [{ "id": "ram", "min": 2 }, { "id": "cpu", "min": 1 }]
}
```

### Multiple GPUs shared between environments

Each physical GPU is its own resource. Multiple environments can reference the same GPUs; the
engine tracks discrete usage **globally**, so no GPU is ever double-allocated across
environments.

```json
"resources": [
  { "id": "gpu0", "kind": "discrete", "type": "gpu", "total": 1,
    "init": { "deviceRequests": { "Driver": "nvidia", "DeviceIDs": ["GPU-uuid-a"], "Capabilities": [["gpu"]] } } },
  { "id": "gpu1", "kind": "discrete", "type": "gpu", "total": 1,
    "init": { "deviceRequests": { "Driver": "nvidia", "DeviceIDs": ["GPU-uuid-b"], "Capabilities": [["gpu"]] } } }
],
"environments": [
  { "id": "premium",  "resources": [ { "id": "cpu" }, { "id": "ram" }, { "id": "gpu0" }, { "id": "gpu1" } ], "fees": { ... } },
  { "id": "standard", "resources": [ { "id": "cpu" }, { "id": "ram" } ],                                     "fees": { ... } }
]
```

### Shareable devices (NIC, TPM, HSM)

Use `kind: "discrete"` and `shareable: true` for devices that multiple jobs may use
simultaneously. The engine tracks `inUse` for visibility but never blocks allocation on them.

```json
{
  "id": "nic0",
  "kind": "discrete",
  "shareable": true,
  "type": "network",
  "total": 1,
  "description": "SR-IOV NIC",
  "init": { "advanced": { "Devices": [{ "PathOnHost": "/dev/net/tun", "PathInContainer": "/dev/net/tun" }] } }
}
```

> `shareable: true` is **not** allowed on `type: "gpu"` or `type: "fpga"` — the node refuses
> to start. GPUs and FPGAs require exclusive per-job access.

### Migration from the old format

The old format placed hardware resources (`init`, `driverVersion`, etc.) inside
environments. This is now a startup error.

```json
// Old (rejected):
"environments": [{ "resources": [{ "id": "myGPU", "total": 1, "init": {...} }] }]

// New:
"resources":    [{ "id": "myGPU", "kind": "discrete", "total": 1, "init": {...} }],
"environments": [{ "resources": [{ "id": "myGPU" }] }]
```

Move all `init`, `description`, `driverVersion`, `platform`, `memoryTotal`, `type`, `kind`,
and `constraints` fields to the connection-level `resources` array. Each environment's
`resources` keeps only `id` and optionally `total`/`min`/`max`/`constraints`.

---

## Environment-level resource refs

These fields go in each environment's `resources` array (lightweight refs to the pool):

| Field | Description |
|---|---|
| `id` | Must match a connection-level resource `id`. `cpu`, `ram`, `disk` are always valid (auto-detected) and are injected as baseline refs even if omitted. |
| `total` | Environment aggregate ceiling: maximum units all jobs in this environment can use simultaneously. Omit to default to the pool total. (Fungible resources only.) |
| `min` | Per-job minimum override for this environment |
| `max` | Per-job maximum override (capped to `total` if both are set) |
| `constraints` | Per-env override — see below. Replaces the pool resource's constraints entirely for this environment. Omit to inherit pool constraints. Set `[]` to remove all constraints for this env. |

---

## Resource constraints

A **constraint** ties one resource's requested amount to another's. Constraints are declared
on a "parent" resource (via its `constraints` array) and are evaluated only when that parent
is actually requested (`amount > 0`). There are two forms.

### Constraint fields

| Field | Description |
|---|---|
| `id` | Target a **single** resource by exact id (e.g. `"ram"`, `"gpu0"`). |
| `type` | Target a **group** of resources by `type` (e.g. `"gpu"`), aggregated across all resources of that type the environment exposes. Mutually exclusive with `id` — set exactly one. |
| `min` | Minimum units of the target. |
| `max` | Maximum units of the target. |
| `perUnit` | `true`/omitted → **ratio**: the bound is `parentAmount × value`. `false` → **floor/ceiling**: the bound is the absolute `value`, regardless of how much of the parent was requested. |
| `aggregate` | Single-`id` targets only. When `true`, this constraint's per-parent contribution is **summed** with matching aggregate constraints on other requested resources into one shared target — so per-device GPUs can jointly scale a companion resource (see below). Rejected on a `type` group. |

Behavior:
- **min** — if the target is below the required minimum it is **auto-bumped** up to it (for a
  group, the deficit is distributed across the group's members, preferring the ones with the
  most availability). If the required minimum exceeds the target's aggregate max, the request
  is rejected with `Cannot satisfy constraint …`.
- **max** — if the target exceeds the allowed maximum the request is rejected with
  `Too much …` (never auto-reduced).

### Companion constraints (single `id`, ratio)

The classic use: a GPU that needs a minimum amount of companion RAM/CPU per unit. This also
prevents the GPU from being scheduled when fungible resources are exhausted.

```json
{
  "id": "gpu0",
  "kind": "discrete",
  "constraints": [
    { "id": "ram", "min": 8 },
    { "id": "cpu", "min": 2 },
    { "id": "disk", "min": 10 }
  ]
}
```

With `perUnit` defaulting to `true`, requesting 1 `gpu0` requires ≥ 8 GB RAM; the amounts
scale with the parent (`requiredMin = gpuAmount × min`).

### `min` + `max` ratios: counted vs per-device resources

Both `min` and `max` are supported, and with the default (ratio) semantics **both** scale by
the parent amount: `requiredMin = parentAmount × min`, `requiredMax = parentAmount × max`.
`min` **auto-bumps** the target up; `max` is **never auto-reduced** — exceeding it throws.

Whether the ratio *aggregates across multiple GPUs* depends on how the GPUs are modeled,
because a constraint's **parent is always a single resource entry** — the engine evaluates
each resource's constraints on its own. (The `type` grouping described below applies only to
the constraint's *target*, not its parent, so there is no "sum across all GPUs" as the
parent.)

Take a GPU constraint of `{ "id": "cpu", "min": 1, "max": 4 }` — "1–4 CPUs per GPU":

**Counted model** — one `gpu` resource with `total: 2`. The parent amount *is* the number of
GPUs requested, so the ratio aggregates:

| Request | Result |
|---|---|
| `gpu: 2` | `cpu` auto-bumped to **2** (= 2 × 1) |
| `gpu: 2, cpu: 8` | allowed (max = 2 × 4 = **8**) |
| `gpu: 2, cpu: 10` | rejected — `Too much cpu for 2 gpu. Max allowed: 8, requested: 10` |

**Per-device model** — separate `GPU1` / `GPU2` resources (each `max: 1`), each carrying the
same constraint. Each is evaluated independently; the parent amount is only ever 0 or 1, so
the bounds **do not sum**:

| Request | Result |
|---|---|
| `GPU1: 1, GPU2: 1` | `cpu` = **1**, *not* 2 — each GPU only requires ≥ 1, they don't add up |
| `GPU1: 1, GPU2: 1, cpu: 5` | rejected — `Too much cpu for 1 GPU1. Max allowed: 4` (max is **4** per GPU, not 8) |

So the "N GPUs ⇒ N×min / N×max" behavior only holds for a single **counted** GPU resource.
The trade-off: a counted resource with explicit `DeviceIDs` attaches *all* of them to the
container regardless of the requested amount, so it can't cleanly pin "1 of 2 physical GPUs"
— use it when you don't need per-device selection. The recommended one-resource-per-GPU model
gives clean per-device allocation and global tracking, but its per-unit constraints are
per-GPU, not aggregated.

#### `aggregate`: summing across per-device GPUs

To get per-device allocation **and** the summed behavior, mark the constraint `aggregate: true`
on each GPU. Matching aggregate constraints (same target `id`) accumulate their per-parent
contribution across every requested GPU into one shared requirement:

```json
{ "id": "GPU1", "constraints": [{ "id": "cpu", "min": 1, "max": 4, "aggregate": true }] },
{ "id": "GPU2", "constraints": [{ "id": "cpu", "min": 1, "max": 4, "aggregate": true }] }
```

| Request | Result |
|---|---|
| `GPU1: 1` | `cpu` in **[1, 4]** (only one GPU contributes) |
| `GPU1: 1, GPU2: 1` | `cpu` auto-bumped to **2** (= 1+1); max is **8** (= 4+4) |
| `GPU1: 1, GPU2: 1, cpu: 10` | rejected — `Too much cpu for the requested resources. Max allowed: 8, requested: 10` |

Notes:
- `aggregate` targets a **single `id`** (it sums *into* one resource); it cannot target a
  `type` group — the config is rejected at startup if you try.
- The summed **min** auto-bumps the target up (capped by the target's own `max`); the summed
  **max** is enforced but never auto-reduces.
- Non-aggregate constraints on the same target keep their independent per-parent behavior; the
  aggregate pass runs after them and only raises the floor further. Avoid mixing aggregate and
  non-aggregate constraints on the same target to keep behavior obvious.

### Group constraints (`type`) + floor (`perUnit: false`)

To express **"if any CPU is selected, the job needs at least 1 GPU — no matter which id"**,
target the `gpu` **group** with an absolute **floor**:

```json
"environments": [
  {
    "resources": [
      { "id": "cpu", "min": 1, "max": 16,
        "constraints": [ { "type": "gpu", "min": 1, "perUnit": false } ] },
      { "id": "ram" },
      { "id": "disk" },
      { "id": "GPU1" },
      { "id": "GPU2" }
    ]
  }
]
```

- `type: "gpu"` aggregates across every `type:"gpu"` resource **the environment exposes**
  (here `GPU1` + `GPU2`).
- `perUnit: false` makes `min: 1` an **absolute floor** — one GPU total is enough whether the
  job asks for 1 CPU or 16 (a ratio would instead demand one GPU *per* CPU).
- If the consumer selects a CPU but requests no GPU, the engine auto-assigns one — picking the
  GPU with the most availability. Because each physical GPU is its own single-`DeviceID`
  resource, exactly that GPU is attached to the container.

> **Place group constraints on the environment's ref, not on the connection-level pool.**
> A pool-level constraint is inherited by *every* environment; in a GPU-less environment the
> `type:"gpu"` group would be empty (aggregate max 0), so the floor of 1 could never be met
> and every CPU job there would be rejected with `Cannot satisfy`.

### Per-env override

Environments can override pool-level constraints via the `EnvironmentResourceRef`:

```json
{ "id": "gpu0", "constraints": [{ "id": "ram", "min": 16 }, { "id": "cpu", "min": 4 }] }
```

Omit `constraints` to inherit the pool's; set `"constraints": []` to remove all constraints
for that environment.

### More constraint recipes

Common patterns, with the behavior verified against the constraint engine. Each snippet shows
just the relevant resource entry; place group/floor constraints on the environment's ref (see
the note above).

**1. RAM range per GPU** — companion `min` + `max` (ratio):

```json
{ "id": "gpu0", "constraints": [{ "id": "ram", "min": 8, "max": 16 }] }
```

Renting `gpu0` forces RAM into **[8, 16]** GB per GPU. RAM below 8 → bumped to 8; `ram: 20` →
rejected (`Too much ram for 1 gpu0. Max allowed: 16, requested: 20`).

**2. One GPU per CPU (strict 1:1)** — group + ratio (`perUnit` omitted), on the env `cpu` ref:

```json
{ "id": "cpu", "constraints": [{ "type": "gpu", "min": 1 }] }
```

`cpu: 2` → the engine auto-assigns **2 GPUs**; `cpu: 3` when only 2 GPUs are exposed → rejected
(`Cannot satisfy constraint: 3 cpu requires at least 3 gpu resources, but max is 2`). Contrast
with `perUnit: false`, which needs just **one** GPU regardless of CPU count.

**3. Cap accelerators per job** — group ceiling (`max` + `perUnit: false`), on the `cpu` ref:

```json
{ "id": "cpu", "constraints": [{ "type": "gpu", "max": 2, "perUnit": false }] }
```

At most **2 GPUs** total per job regardless of CPUs; requesting 3 → rejected (`Too much gpu
resources for 1 cpu. Max allowed: 2, requested: 3`).

**4. Total RAM scales with GPU count** — `aggregate` across per-device GPUs:

```json
{ "id": "GPU1", "constraints": [{ "id": "ram", "min": 8, "aggregate": true }] },
{ "id": "GPU2", "constraints": [{ "id": "ram", "min": 8, "aggregate": true }] }
```

2 GPUs → RAM auto-bumped to **16**; 1 GPU → RAM **8**.

**5. Several companions at once** — multiple constraints on one GPU:

```json
{ "id": "gpu0", "constraints": [
  { "id": "ram", "min": 8 },
  { "id": "cpu", "min": 2 },
  { "id": "disk", "min": 20 }
] }
```

Renting `gpu0` auto-bumps RAM → 8, CPU → 2, disk → 20 in a single pass.

**6. Absolute RAM floor for a GPU job** — `perUnit: false` on a single `id`:

```json
{ "id": "gpu0", "constraints": [{ "id": "ram", "min": 32, "perUnit": false }] }
```

Any job renting `gpu0` gets RAM ≥ **32** total, regardless of GPU count (a ratio would instead
scale RAM with the number of GPUs).

---

## Availability & tracking

Before a job is admitted, the engine checks availability per requested resource:

- **Gate 1 (per-environment ceiling)** — *fungible only*: `env.total - env.inUse >= requested`.
  Controlled by the ref's `total`. Prevents one environment from starving others.
- **Gate 2 (engine-wide pool ceiling)** — *fungible + exclusive discrete*: usage summed
  across all environments must not exceed the pool's physical `total`.

Tracking rules:
- **Fungible** resources (cpu/ram/disk) are tracked **per-environment**.
- **Discrete** resources (GPU/FPGA) are tracked **globally** — a GPU used in one environment
  is unavailable in all others.
- **Shareable discrete** (`shareable:true`, e.g. NIC) are tracked for visibility but never
  block allocation.

Running on-demand **services** occupy the same pool and are counted in the same accounting.

---

## Pricing

`fees` is an object keyed by **chain ID** (string). Each value is an array of fee options:

```json
"fees": {
  "1": [
    {
      "feeToken": "0x...",
      "prices": [
        { "id": "cpu",  "price": 1 },
        { "id": "ram",  "price": 0.5 },
        { "id": "disk", "price": 0.2 },
        { "id": "gpu0", "price": 3 }
      ]
    }
  ]
}
```

- **feeToken**: token contract address used for payment on that chain.
- **prices**: list of `{ "id": "<resourceId>", "price": <number> }`. The `id` must match a
  connection-level resource `id`. Only resources listed here are billable; omit a resource to
  offer it at no charge.

### Pricing units & cost formula

| Resource | Unit of `amount` | Price meaning      | Cost formula                         |
| -------- | ---------------- | ------------------ | ------------------------------------ |
| **CPU**  | Number of CPUs   | Per CPU per minute | `price × cpus × ceil(duration/60)`   |
| **RAM**  | Gigabytes (GB)   | Per GB per minute  | `price × ramGB × ceil(duration/60)`  |
| **Disk** | Gigabytes (GB)   | Per GB per minute  | `price × diskGB × ceil(duration/60)` |
| **GPU**  | Number of GPUs   | Per GPU per minute | `price × gpus × ceil(duration/60)`   |

Duration is always in seconds, converted to minutes with **ceil(duration / 60)** (e.g. 61
seconds → 2 minutes).

**Example** — CPU=1, RAM=0.5, Disk=0.2, GPU=3; job of 2 CPUs, 4 GB RAM, 10 GB disk, 1 GPU for
125 s (ceil = 3 min):

- CPU: 1 × 2 × 3 = **6**
- RAM: 0.5 × 4 × 3 = **6**
- Disk: 0.2 × 10 × 3 = **6**
- GPU: 3 × 1 × 3 = **9** → **Total = 27** (smallest unit of the fee token).

### Multiple chains and tokens

You can support several chains and multiple fee tokens per chain; consumers choose chain and
token when starting a job, and the node uses the matching `prices`.

```json
"fees": {
  "1":   [ { "feeToken": "0xTokenA", "prices": [ { "id": "cpu", "price": 1 } ] },
           { "feeToken": "0xTokenB", "prices": [ { "id": "cpu", "price": 2 } ] } ],
  "137": [ { "feeToken": "0xPolygonToken", "prices": [ { "id": "cpu", "price": 1 } ] } ]
}
```

---

## Free tier

An environment may expose a `free` block permitting jobs with no payment but tighter limits.
List the same resource ids under `free.resources`; a resource not listed there is unavailable
to free jobs even if the paid environment offers it. Free jobs cannot build images.

```json
"free": {
  "maxJobDuration": 60,
  "minJobDuration": 10,
  "maxJobs": 3,
  "resources": [
    { "id": "cpu", "max": 1 },
    { "id": "ram", "max": 2 },
    { "id": "disk", "max": 5 },
    { "id": "gpu0" }
  ]
}
```

---

## Verify

```bash
curl http://localhost:8000/api/services/computeEnvironments
```

The response includes each environment's `resources` fully resolved (including `init`,
`driverVersion`, etc.) and `inUse` counters. Start a free GPU job:

```json
{
  "command": "freeStartCompute",
  "algorithm": {
    "meta": {
      "container": {
        "image": "tensorflow/tensorflow",
        "tag": "2.17.0-gpu",
        "entrypoint": "python $ALGO"
      },
      "rawcode": "import tensorflow as tf\nprint('Num GPUs Available:', len(tf.config.list_physical_devices('GPU')))"
    }
  },
  "consumerAddress": "0x00",
  "signature": "123",
  "nonce": 1,
  "environment": "<env-id-from-computeEnvironments>",
  "resources": [
    { "id": "cpu", "amount": 1 },
    { "id": "gpu0", "amount": 1 }
  ]
}
```

---

## Checklist

- [ ] `DOCKER_COMPUTE_ENVIRONMENTS` (or `dockerComputeEnvironments` in config) is a JSON array.
- [ ] GPUs and other custom hardware are defined in the **connection-level** `resources`
      array with `kind: "discrete"` and exactly one `DeviceID` each.
- [ ] Each environment's `resources` array contains lightweight refs
      (`{ id, total?, min?, max?, constraints? }`).
- [ ] `cpu`, `ram`, `disk` are auto-detected — declare them only to cap/override the value.
- [ ] **Disk** and **RAM** amounts are in **GB**.
- [ ] Group constraints (`type`) live on the **environment ref**, not the connection-level pool.
- [ ] `fees.prices[].id` matches a connection-level resource `id`.
- [ ] **CPU / GPU** price = per resource per minute; **RAM / Disk** price = per GB per minute.
- [ ] For the free tier, list resource ids in `free.resources`; omit from `prices` to make
      them free only.

---

## Full example

A single, valid `DOCKER_COMPUTE_ENVIRONMENTS` (or `dockerComputeEnvironments`) config that
exercises **everything** in this guide at once:

- a **connection-level pool** that caps CPU/RAM/disk and declares **two NVIDIA GPUs**, each
  with companion (`id`, ratio) constraints;
- a paid **`gpu-premium`** environment that guarantees a GPU for any CPU job (group + floor
  constraint), prices resources on **two chains**, and offers a **free tier**;
- a CPU-only **`cpu-standard`** environment — cheaper, no GPU, with its own free tier.

> This exact JSON is validated against the config schema in CI. Replace the GPU `DeviceIDs`,
> `feeToken` addresses, and totals with your own.

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [
      { "id": "cpu",  "type": "cpu",  "total": 16 },
      { "id": "ram",  "type": "ram",  "total": 64 },
      { "id": "disk", "type": "disk", "total": 2000 },
      {
        "id": "GPU1",
        "kind": "discrete",
        "type": "gpu",
        "total": 1,
        "description": "NVIDIA A100 40GB (slot 0)",
        "platform": "nvidia",
        "driverVersion": "570.195.03",
        "memoryTotal": "40960 MiB",
        "init": {
          "deviceRequests": {
            "Driver": "nvidia",
            "DeviceIDs": ["GPU-uuid-1"],
            "Capabilities": [["gpu"]]
          }
        },
        "constraints": [{ "id": "ram", "min": 8 }, { "id": "cpu", "min": 2 }]
      },
      {
        "id": "GPU2",
        "kind": "discrete",
        "type": "gpu",
        "total": 1,
        "description": "NVIDIA A100 40GB (slot 1)",
        "platform": "nvidia",
        "driverVersion": "570.195.03",
        "memoryTotal": "40960 MiB",
        "init": {
          "deviceRequests": {
            "Driver": "nvidia",
            "DeviceIDs": ["GPU-uuid-2"],
            "Capabilities": [["gpu"]]
          }
        },
        "constraints": [{ "id": "ram", "min": 8 }, { "id": "cpu", "min": 2 }]
      }
    ],
    "environments": [
      {
        "id": "gpu-premium",
        "description": "Paid GPU environment — any CPU job is guaranteed a GPU",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "maxJobs": 2,
        "enableNetwork": true,
        "resources": [
          { "id": "cpu", "min": 1, "max": 8,
            "constraints": [{ "type": "gpu", "min": 1, "perUnit": false }] },
          { "id": "ram", "min": 1, "max": 32 },
          { "id": "disk", "min": 1, "max": 500 },
          { "id": "GPU1" },
          { "id": "GPU2" }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu",  "price": 1 },
                { "id": "ram",  "price": 0.5 },
                { "id": "disk", "price": 0.1 },
                { "id": "GPU1", "price": 10 },
                { "id": "GPU2", "price": 10 }
              ]
            }
          ],
          "137": [
            {
              "feeToken": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
              "prices": [
                { "id": "cpu",  "price": 0.5 },
                { "id": "ram",  "price": 0.2 },
                { "id": "GPU1", "price": 5 },
                { "id": "GPU2", "price": 5 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 300,
          "minJobDuration": 10,
          "maxJobs": 1,
          "access": { "addresses": [], "accessLists": null },
          "resources": [
            { "id": "cpu",  "max": 2,
              "constraints": [{ "type": "gpu", "min": 1, "perUnit": false }] },
            { "id": "ram",  "max": 8 },
            { "id": "disk", "max": 10 },
            { "id": "GPU1", "constraints": [{ "id": "ram", "min": 4 }, { "id": "cpu", "min": 1 }] }
          ]
        }
      },
      {
        "id": "cpu-standard",
        "description": "CPU-only environment — cheaper, no GPU",
        "storageExpiry": 604800,
        "maxJobDuration": 1800,
        "minJobDuration": 60,
        "maxJobs": 10,
        "enableNetwork": false,
        "resources": [
          { "id": "cpu",  "total": 8, "min": 1, "max": 4 },
          { "id": "ram",  "total": 16, "min": 1, "max": 8 },
          { "id": "disk", "max": 100 }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu",  "price": 0.3 },
                { "id": "ram",  "price": 0.1 },
                { "id": "disk", "price": 0.05 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 120,
          "minJobDuration": 10,
          "maxJobs": 3,
          "access": { "addresses": [], "accessLists": null },
          "resources": [
            { "id": "cpu",  "max": 1 },
            { "id": "ram",  "max": 2 },
            { "id": "disk", "max": 5 }
          ]
        }
      }
    ]
  }
]
```

### What this config does

**Connection-level pool** — `cpu`/`ram`/`disk` are auto-detected; the declared `total`s only
*cap* them (16 cores, 64 GB RAM, 2 TB disk max for compute). `GPU1` and `GPU2` are two physical
NVIDIA cards, each its own `discrete` resource with a single `DeviceID` and a **companion
constraint**: renting a GPU requires ≥ 8 GB RAM and ≥ 2 CPUs (ratio — per GPU).

**`gpu-premium` (paid + free)**
- **Guaranteed GPU**: the `cpu` ref carries `{ "type": "gpu", "min": 1, "perUnit": false }` — a
  group + **floor** constraint. Any job that requests a CPU must end up with **at least one
  GPU total** (`GPU1` *or* `GPU2`), regardless of how many CPUs. If the consumer didn't ask for
  a GPU, the engine auto-assigns the freer one.
- **Constraint chaining & ordering**: because `cpu` is listed **before** the GPU refs, a single
  resolution pass first satisfies the CPU→GPU floor, then applies the auto-assigned GPU's own
  companion constraints (RAM/CPU). List the floor's parent (`cpu`) before the GPUs so this
  chains in one pass.
- **Pricing on two chains**: Ethereum (`"1"`) and Polygon (`"137"`), each with its own
  `feeToken` and per-resource prices. Consumers pick the chain/token at job start.
- **Free tier**: no payment, tighter caps (≤ 2 CPU, 8 GB RAM, 10 GB disk, 300 s), a single
  concurrent free job, and access to `GPU1` only. Free-tier resource refs are **configured
  independently** from the paid ones — note the floor constraint and `GPU1`'s companion
  constraint are repeated here, because constraints for free jobs are read from
  `free.resources`, not inherited from the paid refs.

**`cpu-standard` (paid + free)** — CPU-only, cheaper prices, higher job concurrency
(`maxJobs: 10`), a modest free tier. It deliberately carries **no** GPU and **no** group
constraint — that's why the `type:"gpu"` floor lives on the environment ref and not the pool: a
pool-level floor would be inherited here and reject every CPU job (empty GPU group).

### Worked scenarios (on `gpu-premium`, paid, chain `"1"`)

The engine resolves the requested resources through the constraints before pricing. Resolved
allocations (verified against the constraint engine):

| Consumer requests | Resolved allocation | Why |
|---|---|---|
| `cpu: 2` | `cpu=2, ram=8, disk=1, GPU1=1` | Floor auto-assigns `GPU1`; its companion bumps RAM to 8 (CPU already ≥ 2). |
| `cpu: 1, GPU2: 1` | `cpu=2, ram=8, disk=1, GPU2=1` | `GPU2` already satisfies the floor; its companion bumps RAM to 8 **and CPU to 2**. |
| `cpu: 1` while `GPU1` is busy | `cpu=2, ram=8, disk=1, GPU2=1` | Floor auto-assigns the freer GPU (`GPU2`); companion bumps RAM/CPU. |

**Cost** for the first row run for 600 s (`ceil(600/60) = 10` min) at chain `"1"` prices
(cpu 1, ram 0.5, disk 0.1, GPU1 10):

```
cpu:  1   × 2 × 10 =  20
ram:  0.5 × 8 × 10 =  40
disk: 0.1 × 1 × 10 =   1
GPU1: 10  × 1 × 10 = 100
                     ----
             total = 161   (smallest unit of the fee token)
```

For all env vars and config options, see [env.md](env.md).
