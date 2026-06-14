# Compute Environment Configuration and Pricing

This guide explains how to configure your node's Docker compute environments and how to set prices for each resource. It covers the `DOCKER_COMPUTE_ENVIRONMENTS` variable (or equivalent config), the fee structure, pricing units, and examples for CPU, RAM, disk, and GPU.

## Overview

- **Configuration**: Define compute environments via the `DOCKER_COMPUTE_ENVIRONMENTS` environment variable (JSON) or via `config.json` under `dockerComputeEnvironments`.
- **Two-level layout**: Resources are defined at the **Docker-connection level** (`socketPath`) and referenced by each environment. This lets multiple environments share the same hardware (e.g. both a paid and a free environment can use the same GPU).
- **Auto-detection**: `cpu` and `ram` are automatically detected from the host at startup. `disk` is measured via `statfs`. You only need to declare them in `resources` if you want to cap/override the detected value.
- **Resources**: The connection-level `resources` array holds full hardware definitions. Each environment's `resources` array holds lightweight refs (`{ id, total?, min?, max? }`) pointing to those pool entries.
- **Dual-gate tracking** (fungible resources like CPU/RAM/disk): Gate 1 enforces the per-environment ceiling; Gate 2 enforces the engine-wide physical pool ceiling. Both must pass for a job to be admitted.
- **Pricing**: For each chain and fee token, you set a `price` per resource. Cost is computed as **price × amount × duration (in minutes, rounded up)**.
- **Free tier**: Environments can have a `free` block that permits jobs with no payment, but with tighter resource limits.
- **Image building**: Free jobs cannot build images (Dockerfiles are not allowed). For paid jobs, image build time counts toward billable duration.

## Pricing Units

| Resource | Unit of `amount` | Price meaning      | Cost formula                         |
| -------- | ---------------- | ------------------ | ------------------------------------ |
| **CPU**  | Number of CPUs   | Per CPU per minute | `price × cpus × ceil(duration/60)`   |
| **RAM**  | Gigabytes (GB)   | Per GB per minute  | `price × ramGB × ceil(duration/60)`  |
| **Disk** | Gigabytes (GB)   | Per GB per minute  | `price × diskGB × ceil(duration/60)` |
| **GPU**  | Number of GPUs   | Per GPU per minute | `price × gpus × ceil(duration/60)`   |

Duration is always in seconds; it is converted to minutes with **ceil(duration / 60)** (e.g. 61 seconds → 2 minutes).

---

## Where to Configure

1. **Environment variable**  
   Set `DOCKER_COMPUTE_ENVIRONMENTS` to a JSON string (array of Docker-connection objects).  
   `export DOCKER_COMPUTE_ENVIRONMENTS='[{"socketPath":"/var/run/docker.sock",...}]'`

2. **Config file**  
   Put the same array in your JSON config under the key `dockerComputeEnvironments`, and point the node to that file (e.g. via `CONFIG_PATH`).

If both are set, the environment variable overrides the config. See [env.md](env.md) for all available fields.

---

## Configuration Layout

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
                ├── { id: "cpu",  total: 4, min: 1, max: 4 }
                ├── { id: "ram",  total: 16, min: 1, max: 8 }
                ├── { id: "disk", max: 20 }
                └── { id: "gpu0" }
```

`cpu`, `ram`, and `disk` are **auto-detected** at startup — you do not need to declare them in the connection-level `resources` array. Include them only to cap the detected value (e.g. limit an 8-core host to 6 cores for compute). Custom hardware (GPUs, NICs) must always be declared.

---

## Connection-level Resource Fields

These fields go in the `resources` array at the Docker-connection level:

| Field | Description |
|---|---|
| `id` | Unique identifier used in env refs and `fees.prices[].id` (e.g. `"cpu"`, `"gpu0"`) |
| `total` | Maximum units available in the pool. For `cpu`/`ram`/`disk`, caps the auto-detected value. |
| `kind` | `"fungible"` (CPU, RAM, disk — interchangeable units) or `"discrete"` (GPU, FPGA — named device). Auto-inferred if omitted: `"discrete"` when `init` is present, `"fungible"` otherwise. |
| `shareable` | `discrete` only. `true` → multiple jobs may use the device simultaneously (e.g. NIC, TPM). `false` (default) → exclusive per job (GPU, FPGA). |
| `min` | Minimum units per job request |
| `max` | Maximum units per job request (defaults to `total`) |
| `type` | Hint string: `"cpu"`, `"ram"`, `"disk"`, `"gpu"` |
| `description` | Human-readable label shown in `getComputeEnvironments` |
| `driverVersion` | GPU driver version string |
| `memoryTotal` | GPU VRAM string (e.g. `"40960 MiB"`) |
| `platform` | GPU vendor: `"nvidia"`, `"amd"`, `"intel"` |
| `init` | Docker container configuration (`deviceRequests` for NVIDIA, `advanced` for AMD/Intel). Makes `kind` default to `"discrete"`. |
| `constraints` | `[{ id, min?, max? }]` — companion resource requirements. When a job rents this resource, linked resources are auto-bumped to their minimums. |

## Environment-level Resource Ref Fields

These fields go in each environment's `resources` array (lightweight refs to the pool):

| Field | Description |
|---|---|
| `id` | Must match a connection-level resource `id`. `cpu`, `ram`, `disk` are always valid (auto-detected). |
| `total` | Environment aggregate ceiling: maximum units all jobs in this environment can use simultaneously. Omit to default to the pool total. |
| `min` | Per-job minimum override for this environment |
| `max` | Per-job maximum override (capped to `total` if both are set) |
| `constraints` | Per-env override: replaces the pool resource's constraints entirely for this environment. Omit to inherit pool constraints. Set `[]` to remove all constraints for this env. |

---

## Fee Structure

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

- **feeToken**: Token contract address used for payment on that chain.
- **prices**: List of `{ "id": "<resourceId>", "price": <number> }`.  
  The `id` in `prices` must match a connection-level resource `id`. Only resources listed here are billable; omit a resource to offer it at no charge.

---

## Cost Examples

Assume:

- **CPU** price = 1 (per CPU per minute)
- **RAM** price = 0.5 (per GB per minute)
- **Disk** price = 0.2 (per GB per minute)
- **GPU** price = 3 (per GPU per minute)

Job: 2 CPUs, 4 GB RAM, 10 GB disk, 1 GPU, duration **125 seconds** (ceil = 3 minutes).

- CPU: 1 × 2 × 3 = **6**
- RAM: 0.5 × 4 × 3 = **6**
- Disk: 0.2 × 10 × 3 = **6**
- GPU: 3 × 1 × 3 = **9**  
  **Total cost = 27** (in the smallest unit of the fee token).

---

## Example 1: CPU, RAM, and Disk with Prices

`cpu` and `ram` are auto-detected, so they don't need to appear in `resources`. Only `disk` is declared here to cap it at 10 GB.

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [
      { "id": "disk", "total": 10 }
    ],
    "environments": [
      {
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "resources": [
          { "id": "cpu" },
          { "id": "ram" },
          { "id": "disk", "max": 10 }
        ],
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu",  "price": 1 },
                { "id": "ram",  "price": 0.5 },
                { "id": "disk", "price": 0.2 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 60,
          "minJobDuration": 10,
          "maxJobs": 3,
          "resources": [
            { "id": "cpu",  "max": 1 },
            { "id": "ram",  "max": 1 },
            { "id": "disk", "max": 1 }
          ]
        }
      }
    ]
  }
]
```

---

## Example 2: CPU + NVIDIA GPU

Get the GPU UUID:

```bash
nvidia-smi --query-gpu=name,uuid --format=csv
```

Define the GPU at the **connection level** with `kind: "discrete"` and a single `DeviceID`. Each physical GPU is its own resource entry. The environment references it by `id`.

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [
      { "id": "disk", "total": 10 },
      {
        "id": "gpu0",
        "kind": "discrete",
        "type": "gpu",
        "total": 1,
        "description": "NVIDIA GeForce GTX 1060 3GB",
        "platform": "nvidia",
        "init": {
          "deviceRequests": {
            "Driver": "nvidia",
            "DeviceIDs": ["GPU-294c6802-bb2f-fedb-f9e0-a26b9142dd81"],
            "Capabilities": [["gpu"]]
          }
        }
      }
    ],
    "environments": [
      {
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "resources": [
          { "id": "cpu" },
          { "id": "ram" },
          { "id": "disk", "max": 10 },
          { "id": "gpu0" }
        ],
        "fees": {
          "1": [
            {
              "feeToken": "0x123",
              "prices": [
                { "id": "cpu",  "price": 1 },
                { "id": "gpu0", "price": 3 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 60,
          "minJobDuration": 10,
          "maxJobs": 3,
          "resources": [
            { "id": "cpu",  "max": 1 },
            { "id": "ram",  "max": 1 },
            { "id": "disk", "max": 1 }
          ]
        }
      }
    ]
  }
]
```

The `id` in `fees.prices` (`"gpu0"`) must match the connection-level resource `id`. Price 3 = 3 units per GPU per minute.

---

## Example 3: Multiple Chains and Tokens

You can support several chains and multiple fee tokens per chain:

```json
"fees": {
  "1": [
    {
      "feeToken": "0xTokenA",
      "prices": [
        { "id": "cpu",  "price": 1 },
        { "id": "ram",  "price": 0.5 },
        { "id": "disk", "price": 0.2 }
      ]
    },
    {
      "feeToken": "0xTokenB",
      "prices": [
        { "id": "cpu",  "price": 2 },
        { "id": "ram",  "price": 1 },
        { "id": "disk", "price": 0.5 }
      ]
    }
  ],
  "137": [
    {
      "feeToken": "0xPolygonToken",
      "prices": [
        { "id": "cpu",  "price": 1 },
        { "id": "ram",  "price": 0.5 },
        { "id": "disk", "price": 0.2 }
      ]
    }
  ]
}
```

Consumers choose chain and token when starting a job; the node uses the matching `prices` for that chain and token.

---

## Example 4: AMD or Intel GPU

For **AMD (e.g. ROCm)** or **Intel Arc**, define the GPU at the connection level with `init.advanced` instead of `deviceRequests`. The environment references it by `id` just like any other resource.

- **AMD Radeon**: See [GPU.md – AMD Radeon](GPU.md#amd-radeon-example) for the `advanced` block (Devices, Binds, CapAdd, etc.).
- **Intel Arc**: See [GPU.md – Intel Arc GPU](GPU.md#intel-arc-gpu-example) for the `advanced` block (Devices, GroupAdd, CapAdd).

In all cases, the pricing rule is: **price × amount × ceil(duration/60)** with amount = number of GPUs.

---

## Dual-gate Availability (Fungible Resources)

For `cpu`, `ram`, and `disk`, two independent checks must pass before a job is admitted:

- **Gate 1 (per-environment ceiling)**: `env.total - env.inUse >= requested`. Controlled by `EnvironmentResourceRef.total` in the environment's `resources` array. Prevents one environment from starving others.
- **Gate 2 (engine-wide pool ceiling)**: The sum of in-use across all environments must not exceed the pool's `total`. Enforces the physical hardware limit.

For discrete resources (GPU), only Gate 2 applies — and only for exclusive (`shareable: false`, the default) devices.

---

## Checklist

- [ ] `DOCKER_COMPUTE_ENVIRONMENTS` (or `dockerComputeEnvironments` in config) is a JSON array.
- [ ] GPUs and other custom hardware are defined in the **connection-level** `resources` array with `kind: "discrete"`.
- [ ] Each environment's `resources` array contains lightweight refs (`{ id, total?, min?, max? }`).
- [ ] `cpu`, `ram`, `disk` are auto-detected — only declare them in `resources` to cap/override the detected value.
- [ ] **Disk** and **RAM** amounts are in **GB**.
- [ ] `fees.prices[].id` matches a connection-level resource `id`.
- [ ] **CPU / GPU**: price = per resource per minute.
- [ ] **RAM / Disk**: price = per GB per minute.
- [ ] For free tier, list the same resource ids in `free.resources`; omit from `prices` if they should be free only.

For GPU setup details (NVIDIA, AMD, Intel), see [GPU.md](GPU.md). For all env vars and config options, see [env.md](env.md).
