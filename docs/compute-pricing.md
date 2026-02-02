# Compute Environment Configuration and Pricing

This guide explains how to configure your node’s Docker compute environments and how to set prices for each resource. It covers the `DOCKER_COMPUTE_ENVIRONMENTS` variable (or equivalent config), the fee structure, pricing units, and examples for CPU, RAM, disk, and GPU.

## Overview

- **Configuration**: Define compute environments via the `DOCKER_COMPUTE_ENVIRONMENTS` environment variable (JSON) or via `config.json` under `dockerComputeEnvironments`.
- **Resources**: Each environment declares resources (e.g. `cpu`, `ram`, `disk`, and optionally GPUs). You must declare a `disk` resource.
- **Pricing**: For each chain and fee token, you set a `price` per resource. Cost is computed as **price × amount × duration (in minutes, rounded up)**.

## Pricing Units

| Resource | Unit of `amount` | Price meaning      | Cost formula                         |
| -------- | ---------------- | ------------------ | ------------------------------------ |
| **CPU**  | Number of CPUs   | Per CPU per minute | `price × cpus × ceil(duration/60)`   |
| **RAM**  | Gigabytes (GB)   | Per GB per minute  | `price × ramGB × ceil(duration/60)`  |
| **Disk** | Gigabytes (GB)   | Per GB per minute  | `price × diskGB × ceil(duration/60)` |
| **GPU**  | Number of GPUs   | Per GPU per minute | `price × gpus × ceil(duration/60)`   |

So:

- **CPU and GPU**: price is **per resource per minute** (e.g. 2 CPUs at price 1 for 90 minutes → 2 × 1 × 90 = 180).
- **Memory (RAM) and storage (disk)**: price is **per minute per gigabyte** (e.g. 4 GB RAM at price 0.5 for 60 minutes → 0.5 × 4 × 60 = 120).

Duration is always in seconds; it is converted to minutes with **ceil(duration / 60)** (e.g. 61 seconds → 2 minutes).

---

## Where to Configure

1. **Environment variable**  
   Set `DOCKER_COMPUTE_ENVIRONMENTS` to a JSON string (array of compute environment objects).  
   Example:  
   `export DOCKER_COMPUTE_ENVIRONMENTS='[{"socketPath":"/var/run/docker.sock",...}]'`

2. **Config file**  
   Put the same array in your JSON config under the key `dockerComputeEnvironments`, and point the node to that file (e.g. via `CONFIG_PATH`).

If both are set, the environment variable typically overrides the config. See [Environmental Variables](env.md) and `ENVIRONMENT_VARIABLES` in `src/utils/constants.ts`.

---

## Environment Structure (Summary)

Each element of `DOCKER_COMPUTE_ENVIRONMENTS` is an object with at least:

- **socketPath**: Docker socket (e.g. `"/var/run/docker.sock"`).
- **resources**: List of resources (see below). Must include `disk`.
- **storageExpiry**, **maxJobDuration**, **minJobDuration**: Required (seconds).
- **fees**: Per-chain, per-token pricing (see next section).
- **access** (optional): Who can run paid jobs (`addresses`, `accessLists`).
- **free** (optional): Limits and access for free jobs.

### Resources

- **cpu**, **ram**, **disk**: Standard resources. `disk` is mandatory.  
  **Disk** and **RAM** are in **GB** (e.g. `"total": 10` = 10 GB).
- **GPU**: Add a resource with `"type": "gpu"` and either `deviceRequests` (NVIDIA) or `advanced` (AMD/Intel). See [GPU.md](GPU.md) for full examples.

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
        { "id": "myGPU", "price": 3 }
      ]
    }
  ]
}
```

- **feeToken**: Token contract address used for payment on that chain.
- **prices**: List of `{ "id": "<resourceId>", "price": <number> }`.  
  Only resources listed here are billable; omit a resource to offer it without charge (e.g. for free tier only).

**Important**: The `id` in `prices` must match the resource `id` in `resources` and in `free.resources` (e.g. if the GPU resource is `"id": "myGPU"`, use `"id": "myGPU"` in `prices`, not `"nyGPU"`).

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

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [{ "id": "disk", "total": 10 }],
    "storageExpiry": 604800,
    "maxJobDuration": 3600,
    "minJobDuration": 60,
    "fees": {
      "1": [
        {
          "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
          "prices": [
            { "id": "cpu", "price": 1 },
            { "id": "ram", "price": 0.5 },
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
        { "id": "cpu", "max": 1 },
        { "id": "ram", "max": 1 },
        { "id": "disk", "max": 1 }
      ]
    }
  }
]
```

- **CPU**: 1 unit per CPU per minute.
- **RAM**: 0.5 units per GB per minute.
- **Disk**: 0.2 units per GB per minute.

---

## Example 2: CPU + NVIDIA GPU

Get the GPU UUID:

```bash
nvidia-smi --query-gpu=name,uuid --format=csv
```

Then define one GPU and set a price per GPU per minute (e.g. 3):

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [
      {
        "id": "myGPU",
        "description": "NVIDIA GeForce GTX 1060 3GB",
        "type": "gpu",
        "total": 1,
        "init": {
          "deviceRequests": {
            "Driver": "nvidia",
            "DeviceIDs": ["GPU-294c6802-bb2f-fedb-f9e0-a26b9142dd81"],
            "Capabilities": [["gpu"]]
          }
        }
      },
      { "id": "disk", "total": 1 }
    ],
    "storageExpiry": 604800,
    "maxJobDuration": 3600,
    "minJobDuration": 60,
    "fees": {
      "1": [
        {
          "feeToken": "0x123",
          "prices": [
            { "id": "cpu", "price": 1 },
            { "id": "myGPU", "price": 3 }
          ]
        }
      ]
    },
    "free": {
      "maxJobDuration": 60,
      "minJobDuration": 10,
      "maxJobs": 3,
      "resources": [
        { "id": "cpu", "max": 1 },
        { "id": "ram", "max": 1 },
        { "id": "disk", "max": 1 },
        { "id": "myGPU", "max": 1 }
      ]
    }
  }
]
```

Ensure the fee `id` matches the resource `id` (`myGPU`). Price 3 = 3 units per GPU per minute.

---

## Example 3: Multiple Chains and Tokens

You can support several chains and multiple fee tokens per chain:

```json
"fees": {
  "1": [
    {
      "feeToken": "0xTokenA",
      "prices": [
        { "id": "cpu", "price": 1 },
        { "id": "ram", "price": 0.5 },
        { "id": "disk", "price": 0.2 }
      ]
    },
    {
      "feeToken": "0xTokenB",
      "prices": [
        { "id": "cpu", "price": 2 },
        { "id": "ram", "price": 1 },
        { "id": "disk", "price": 0.5 }
      ]
    }
  ],
  "137": [
    {
      "feeToken": "0xPolygonToken",
      "prices": [
        { "id": "cpu", "price": 1 },
        { "id": "ram", "price": 0.5 },
        { "id": "disk", "price": 0.2 }
      ]
    }
  ]
}
```

Consumers choose chain and token when starting a job; the node uses the matching `prices` for that chain and token.

---

## Example 4: AMD or Intel GPU

For **AMD (e.g. ROCm on WSL2)** or **Intel Arc**, use a GPU resource with `init.advanced` instead of `deviceRequests`. Still set a **per-GPU per-minute** price in `fees.prices` (same formula: price × gpus × ceil(duration/60)).

- **AMD Radeon (WSL2/ROCm)**: See [GPU.md – AMD Radeon 9070 XT](GPU.md#amd-radeon-9070-xt-on-wsl2) for `advanced` (Devices, Binds, CapAdd, etc.). Use a consistent `id` (e.g. `myGPU`) in `resources` and in `fees.prices`.
- **Intel Arc**: See [GPU.md – Intel Arc GPU](GPU.md#intel-arc-gpu-example) for `advanced` (Devices, GroupAdd, CapAdd). Again, use the same `id` in `fees.prices` (e.g. `intelGPU`).

In all cases, the pricing rule is: **price × amount × ceil(duration/60)** with amount = number of GPUs.

---

## Checklist

- [ ] `DOCKER_COMPUTE_ENVIRONMENTS` (or `dockerComputeEnvironments` in config) is a JSON array.
- [ ] Every environment has a **disk** resource (and optionally cpu, ram, GPU).
- [ ] **Disk** and **RAM** amounts are in **GB**.
- [ ] **fees** has an entry per chain ID; each entry has `feeToken` and `prices` with `id` matching resource ids.
- [ ] **CPU / GPU**: price = per resource per minute.
- [ ] **RAM / Disk**: price = per GB per minute.
- [ ] For free tier, list the same resource ids in `free.resources`; omit from `prices` if they should be free only.

For GPU setup details (NVIDIA, AMD, Intel), see [GPU.md](GPU.md). For other env vars and config options, see [env.md](env.md).
