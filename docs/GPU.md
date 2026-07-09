Supporting GPUs for c2d jobs comes down to:

- define each GPU as a named resource at the **connection level** (same level as `socketPath`)
- pass docker device args inside each GPU's `init` block
- reference the GPU by id in the environment's `resources` list
- set a price for each GPU in the environment's `fees` (see [Compute pricing](compute-pricing.md))

## Key rules

- Each physical GPU is its own resource with a unique id and exactly **one** `DeviceID`.
- `kind: "discrete"` (non-fungible): only one job at a time can use the device. This is the default when `init` is present.
- `cpu`, `ram`, and `disk` are **auto-detected** from the host — you do not need to declare them unless you want to cap their totals.
- Environment `resources` are **lightweight refs** (`id` + optional `total`/`min`/`max`/`constraints`). Hardware details (`init`, `driverVersion`, `platform`, etc.) live only at connection level.

> **Security note**: `init.advanced` entries (`Binds`, `CapAdd`, `Devices`, `SecurityOpt`) apply to every job in every environment that references the resource. Review them carefully before adding to production configs.

---

## NVIDIA GPU Example

Install nvidia cuda drivers (https://docs.nvidia.com/cuda/cuda-installation-guide-linux/) and nvidia container toolkit (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

Check your GPU details:

```
root@gpu-1:/repos/ocean/ocean-node# nvidia-smi
Fri Apr 25 06:00:34 2025
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 550.163.01             Driver Version: 550.163.01     CUDA Version: 12.4     |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |                  N/A |
|=========================================+========================+======================|
|   0  NVIDIA GeForce GTX 1060 3GB    Off |   00000000:01:00.0 Off |                  N/A |
|  0%   39C    P8              6W /  120W |       2MiB /   3072MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+

+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI        PID   Type   Process name                              GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|  No running processes found                                                             |
+-----------------------------------------------------------------------------------------+
```

Get the GPU UUID:

```bash
root@gpu-1:/repos/ocean/ocean-node# nvidia-smi --query-gpu=name,uuid,driver_version,memory.total --format=csv
name, uuid, driver version, memory total
NVIDIA GeForce GTX 1060 3GB, GPU-294c6802-bb2f-fedb-f9e0-a26b9142dd81, 570.195.03, 3072 MiB
```

Full `DOCKER_COMPUTE_ENVIRONMENTS` configuration:

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
        "constraints": [
          { "id": "ram", "min": 2 },
          { "id": "cpu", "min": 1 }
        ]
      }
    ],

    "environments": [
      {
        "id": "gpu-env",
        "description": "NVIDIA GPU environment",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "enableNetwork": false,
        "resources": [
          { "id": "cpu", "min": 1, "max": 4 },
          { "id": "ram", "min": 1, "max": 8 },
          { "id": "disk", "min": 1, "max": 50 },
          { "id": "gpu0" }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu", "price": 1 },
                { "id": "gpu0", "price": 3 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 60,
          "minJobDuration": 10,
          "maxJobs": 3,
          "access": { "addresses": [], "accessLists": null },
          "resources": [
            { "id": "cpu", "max": 1 },
            { "id": "ram", "max": 2 },
            { "id": "disk", "max": 5 },
            { "id": "gpu0" }
          ]
        }
      }
    ]
  }
]
```

Verify:

```bash
curl http://localhost:8000/api/services/computeEnvironments
```

The response includes `resources` with the GPU fully resolved (including `init`, `driverVersion`, etc.) and `inUse` counters.

Start a free GPU job:

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

## AMD Radeon GPU Example

Install ROCm (https://rocm.docs.amd.com/projects/radeon/en/latest/docs/install/wsl/install-radeon.html).

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
        "constraints": [
          { "id": "ram", "min": 4 },
          { "id": "cpu", "min": 2 }
        ]
      }
    ],

    "environments": [
      {
        "id": "amd-gpu-env",
        "description": "AMD Radeon GPU environment",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "enableNetwork": false,
        "resources": [
          { "id": "cpu", "min": 1, "max": 4 },
          { "id": "ram", "min": 1, "max": 16 },
          { "id": "disk", "min": 1, "max": 50 },
          { "id": "gpu0" }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu", "price": 1 },
                { "id": "gpu0", "price": 3 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 60,
          "minJobDuration": 10,
          "maxJobs": 3,
          "access": { "addresses": [], "accessLists": null },
          "resources": [
            { "id": "cpu", "max": 1 },
            { "id": "ram", "max": 4 },
            { "id": "disk", "max": 5 },
            { "id": "gpu0" }
          ]
        }
      }
    ]
  }
]
```

Start a free job:

```json
{
  "command": "freeStartCompute",
  "algorithm": {
    "meta": {
      "container": {
        "image": "rocm/tensorflow",
        "tag": "rocm6.4-py3.12-tf2.18-dev",
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

## Intel Arc GPU Example

Install Intel GPU drivers (https://dgpu-docs.intel.com/driver/installation.html).

```bash
root@gpu-1:/repos/ocean/ocean-node# clinfo
Number of platforms: 1
  Platform #0: Intel(R) OpenCL Graphics
    Number of devices: 1
      Device #0: Intel(R) Arc(TM) A770M Graphics
        Board name: Intel Arc Graphics
        Vendor ID: 0x8086
        Device ID: 0x56a0
        Device Topology (NV12): PCI[ B#3 D#0 F#0 ]
        Max compute units: 32
        Max clock frequency: 2400 MHz
```

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
        "constraints": [
          { "id": "ram", "min": 2 },
          { "id": "cpu", "min": 1 }
        ]
      }
    ],

    "environments": [
      {
        "id": "intel-gpu-env",
        "description": "Intel Arc GPU environment",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "enableNetwork": false,
        "resources": [
          { "id": "cpu", "min": 1, "max": 4 },
          { "id": "ram", "min": 1, "max": 8 },
          { "id": "disk", "min": 1, "max": 50 },
          { "id": "gpu0" }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu", "price": 1 },
                { "id": "gpu0", "price": 2 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 60,
          "minJobDuration": 10,
          "maxJobs": 3,
          "access": { "addresses": [], "accessLists": null },
          "resources": [
            { "id": "cpu", "max": 1 },
            { "id": "ram", "max": 2 },
            { "id": "disk", "max": 5 },
            { "id": "gpu0" }
          ]
        }
      }
    ]
  }
]
```

---

## Multiple GPUs — Shared Between Environments

Each physical GPU is its own resource. Both environments can reference both GPUs; the engine tracks usage globally so no GPU is ever double-allocated.

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
        "description": "NVIDIA A100 40GB (slot 0)",
        "platform": "nvidia",
        "driverVersion": "570.195.03",
        "memoryTotal": "40960 MiB",
        "init": {
          "deviceRequests": {
            "Driver": "nvidia",
            "DeviceIDs": ["GPU-uuid-a"],
            "Capabilities": [["gpu"]]
          }
        },
        "constraints": [
          { "id": "ram", "min": 8 },
          { "id": "cpu", "min": 2 }
        ]
      },
      {
        "id": "gpu1",
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
            "DeviceIDs": ["GPU-uuid-b"],
            "Capabilities": [["gpu"]]
          }
        },
        "constraints": [
          { "id": "ram", "min": 8 },
          { "id": "cpu", "min": 2 }
        ]
      }
    ],

    "environments": [
      {
        "id": "premium",
        "description": "Full GPU access",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "enableNetwork": true,
        "resources": [
          { "id": "cpu", "total": 16, "min": 1, "max": 8 },
          { "id": "ram", "total": 60, "min": 1, "max": 32 },
          { "id": "disk", "total": 200, "min": 1, "max": 100 },
          { "id": "gpu0" },
          { "id": "gpu1" }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu", "price": 1 },
                { "id": "ram", "price": 0.5 },
                { "id": "gpu0", "price": 10 },
                { "id": "gpu1", "price": 10 }
              ]
            }
          ]
        }
      },
      {
        "id": "standard",
        "description": "CPU only",
        "storageExpiry": 604800,
        "maxJobDuration": 1800,
        "minJobDuration": 60,
        "enableNetwork": false,
        "resources": [
          { "id": "cpu", "total": 8, "min": 1, "max": 4 },
          { "id": "ram", "total": 16, "min": 1, "max": 8 },
          { "id": "disk", "total": 50, "min": 1, "max": 50 }
        ],
        "access": { "addresses": [], "accessLists": null },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [
                { "id": "cpu", "price": 0.5 },
                { "id": "ram", "price": 0.2 }
              ]
            }
          ]
        },
        "free": {
          "maxJobDuration": 300,
          "minJobDuration": 10,
          "maxJobs": 3,
          "access": { "addresses": [], "accessLists": null },
          "resources": [
            { "id": "cpu", "max": 1 },
            { "id": "ram", "max": 2 },
            { "id": "disk", "max": 5 }
          ]
        }
      }
    ]
  }
]
```

---

## Shareable Devices (NIC, TPM, HSM)

Use `kind: "discrete"` and `shareable: true` for devices that multiple jobs may use simultaneously. The engine tracks `inUse` for visibility but never blocks allocation.

```json
{
  "id": "nic0",
  "kind": "discrete",
  "shareable": true,
  "type": "network",
  "total": 1,
  "description": "SR-IOV NIC",
  "init": {
    "advanced": {
      "Devices": [{ "PathOnHost": "/dev/net/tun", "PathInContainer": "/dev/net/tun" }]
    }
  }
}
```

> `shareable: true` is **not** allowed on `type: "gpu"` or `type: "fpga"` — the node will refuse to start. GPUs and FPGAs require exclusive per-job access.

---

## Resource Constraints

Constraints on a GPU resource define minimum companion resources required per job. When a user requests the GPU, the engine automatically allocates at least the constrained amounts. This also prevents the GPU from being scheduled when fungible resources (RAM, CPU) are exhausted.

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

Environments can override pool-level constraints via the `EnvironmentResourceRef`:

```json
{ "id": "gpu0", "constraints": [{ "id": "ram", "min": 16 }, { "id": "cpu", "min": 4 }] }
```

Set `"constraints": []` to remove all constraints for a specific environment.

---

## Migration from old format

The old format placed hardware resources (`init`, `driverVersion`, etc.) inside environments. This is now a startup error.

**Old (rejected):**
```json
"environments": [{ "resources": [{ "id": "myGPU", "total": 1, "init": {...} }] }]
```

**New:**
```json
"resources": [{ "id": "myGPU", "kind": "discrete", "total": 1, "init": {...} }],
"environments": [{ "resources": [{ "id": "myGPU" }] }]
```

Move all `init`, `description`, `driverVersion`, `platform`, `memoryTotal`, `type`, `kind`, and `constraints` fields to the connection-level `resources` array. Each environment's `resources` keeps only `id` and optionally `total`/`min`/`max`/`constraints`.
