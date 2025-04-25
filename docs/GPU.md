Supporting GPUs for c2d jobs comes down to:

- define gpu list for each c2d env
- pass docker args for each gpu
- set a price for each gpu

## Nvidia GPU Example

Start by installing nvidia cuda drivers (ie:https://docs.nvidia.com/cuda/cuda-installation-guide-linux/), then install nvidia container toolkit (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

Once that is done, check if you can get gpu details by running 'nvidia-smi':

```
root@gpu-1:/repos/ocean/ocean-node# nvidia-smi
Fri Apr 25 06:00:34 2025
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 550.163.01             Driver Version: 550.163.01     CUDA Version: 12.4     |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
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

Now, time to get the id of the gpu:

```bash
root@gpu-1:/repos/ocean/ocean-node# nvidia-smi --query-gpu=name,uuid --format=csv
name, uuid
NVIDIA GeForce GTX 1060 3GB, GPU-294c6802-bb2f-fedb-f9e0-a26b9142dd81
```

Now, we can define the gpu for node:

```json
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
}
```

Don't forget to add it to fees definition and free definition (if desired).

Here is the full definition of DOCKER_COMPUTE_ENVIRONMENTS:

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
      { "id": "disk", "total": 1000000000 }
    ],
    "storageExpiry": 604800,
    "maxJobDuration": 3600,
    "fees": {
      "1": [
        {
          "feeToken": "0x123",
          "prices": [
            { "id": "cpu", "price": 1 },
            { "id": "nyGPU", "price": 3 }
          ]
        }
      ]
    },
    "free": {
      "maxJobDuration": 60,
      "maxJobs": 3,
      "resources": [
        { "id": "cpu", "max": 1 },
        { "id": "ram", "max": 1000000000 },
        { "id": "disk", "max": 1000000000 },
        { "id": "myGPU", "max": 1 }
      ]
    }
  }
]
```

And you should have it in your compute envs:

```bash
root@gpu-1:/repos/ocean/ocean-node# curl http://localhost:8000/api/services/computeEnvironments
```

```json
[
  {
    "id": "0xd6b10b27aab01a72070a5164c07d0517755838b9cb9857e2d5649287ec3aaaa2-0x66073c81f833deaa2f8e2a508f69cf78f8a99b17ba1a64f369af921750f93914",
    "runningJobs": 0,
    "consumerAddress": "0x4fb80776C8eb4cAbe7730dcBCdb1fa6ecD3c460E",
    "platform": { "architecture": "x86_64", "os": "Ubuntu 22.04.3 LTS" },
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
    "storageExpiry": 604800,
    "maxJobDuration": 3600,
    "resources": [
      { "id": "cpu", "total": 8, "max": 8, "min": 1, "inUse": 0 },
      {
        "id": "ram",
        "total": 24888963072,
        "max": 24888963072,
        "min": 1000000000,
        "inUse": 0
      },
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
        },
        "max": 1,
        "min": 0,
        "inUse": 0
      },
      { "id": "disk", "total": 1000000000, "max": 1000000000, "min": 0, "inUse": 0 }
    ],
    "free": {
      "maxJobDuration": 60,
      "maxJobs": 3,
      "resources": [
        { "id": "cpu", "max": 1, "inUse": 0 },
        { "id": "ram", "max": 1000000000, "inUse": 0 },
        { "id": "disk", "max": 1000000000, "inUse": 0 },
        { "id": "myGPU", "max": 1, "inUse": 0 }
      ]
    },
    "runningfreeJobs": 0
  }
]
```

## Testing

Start a free job using:

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
      "rawcode": "import tensorflow as tf\nsess = tf.compat.v1.Session(config=tf.compat.v1.ConfigProto(log_device_placement=True))\nprint(\"Num GPUs Available: \", len(tf.config.list_physical_devices('GPU')))\ngpus = tf.config.list_physical_devices('GPU')\nfor gpu in gpus:\n\tprint('Name:', gpu.name, '  Type:', gpu.device_type)"
    }
  },
  "consumerAddress": "0xC7EC1970B09224B317c52d92f37F5e1E4fF6B687",
  "signature": "123",
  "nonce": 1,
  "environment": "0xd6b10b27aab01a72070a5164c07d0517755838b9cb9857e2d5649287ec3aaaa2-0x66073c81f833deaa2f8e2a508f69cf78f8a99b17ba1a64f369af921750f93914",
  "resources": [
    {
      "id": "cpu",
      "amount": 1
    },
    {
      "id": "myGPU",
      "amount": 1
    }
  ]
}
```

And the output of `getComputeResult` should look like:

```bash
2025-04-25 06:18:20.890217: E external/local_xla/xla/stream_executor/cuda/cuda_fft.cc:485] Unable to register cuFFT factory: Attempting to register factory for plugin cuFFT when one has already been registered
2025-04-25 06:18:21.192330: E external/local_xla/xla/stream_executor/cuda/cuda_dnn.cc:8454] Unable to register cuDNN factory: Attempting to register factory for plugin cuDNN when one has already been registered
2025-04-25 06:18:21.292230: E external/local_xla/xla/stream_executor/cuda/cuda_blas.cc:1452] Unable to register cuBLAS factory: Attempting to register factory for plugin cuBLAS when one has already been registered
WARNING: All log messages before absl::InitializeLog() is called are written to STDERR
I0000 00:00:1745561915.985558       1 cuda_executor.cc:1015] successful NUMA node read from SysFS had negative value (-1), but there must be at least one NUMA node, so returning NUMA node zero. See more at https://github.com/torvalds/linux/blob/v6.0/Documentation/ABI/testing/sysfs-bus-pci#L344-L355
I0000 00:00:1745561915.993514       1 cuda_executor.cc:1015] successful NUMA node read from SysFS had negative value (-1), but there must be at least one NUMA node, so returning NUMA node zero. See more at https://github.com/torvalds/linux/blob/v6.0/Documentation/ABI/testing/sysfs-bus-pci#L344-L355
I0000 00:00:1745561915.993799       1 cuda_executor.cc:1015] successful NUMA node read from SysFS had negative value (-1), but there must be at least one NUMA node, so returning NUMA node zero. See more at https://github.com/torvalds/linux/blob/v6.0/Documentation/ABI/testing/sysfs-bus-pci#L344-L355
Num GPUs Available:  1
Name: /physical_device:GPU:0   Type: GPU
```
