#!/usr/bin/env bash

# Function to check for NVIDIA GPUs
get_nvidia_gpus() {
    if command -v nvidia-smi &> /dev/null; then
        # Query nvidia-smi for GPU count, names, and UUIDs
        # We use csv format for easier parsing
        nvidia-smi --query-gpu=name,uuid,driver_version,memory.total --format=csv,noheader | while IFS=, read -r name uuid driver_version memory_total; do
            # Trim leading/trailing whitespace
            name=$(echo "$name" | xargs)
            uuid=$(echo "$uuid" | xargs)
            driver_version=$(echo "$driver_version" | xargs)
            memory_total=$(echo "$memory_total" | xargs)
            
            # Create a JSON object for this GPU
            # Note: We use the UUID as the ID locally, but it will be aggregated later
             jq -c -n \
                --arg name "$name" \
                --arg uuid "$uuid" \
                --arg driver_version "$driver_version" \
                --arg memory_total "$memory_total" \
                '{
                    description: $name,
                    init: {
                        deviceRequests: {
                            Driver: "nvidia",
                            Devices: [$uuid],
                            DriverVersion: $driver_version,
                            MemoryTotal: $memory_total
                        }
                    }
                }'
        done
    fi
}

get_driver_version() {
    local module="$1"

    # Try the version field first (present when built as a loadable module)
    local ver
    ver=$(modinfo "$module" 2>/dev/null | awk '/^version:/ {print $2; exit}')
    if [ -n "$ver" ]; then
        echo "$ver"
        return
    fi

    # If module exists but only has srcversion (built-in to kernel - integrated 
    # GPU), fall back to the kernel version as the effective driver version
    if modinfo "$module" 2>/dev/null | grep -q "^srcversion:"; then
        uname -r
        return
    fi
}

get_intel_driver_version() {
    # oneAPI / Level Zero runtime (Intel Arc)
    local ver

    # Try clinfo first (works for both oneAPI and standard OpenCL)
    ver=$(clinfo 2>/dev/null | awk '/Driver Version/ {print $NF; exit}')
    [ -n "$ver" ] && { echo "$ver"; return; }

    # Try package manager
    ver=$(dpkg -l 2>/dev/null | awk '/intel-level-zero-gpu/ {print $3; exit}')
    [ -z "$ver" ] && ver=$(rpm -q --qf '%{VERSION}' intel-level-zero-gpu 2>/dev/null)
    [ -n "$ver" ] && { echo "$ver"; return; }

    # Fall back to kernel module / kernel version
    get_driver_version "xe" || get_driver_version "i915"
}

get_amd_driver_version() {
    local ver

    # ROCm version file (most reliable)
    ver=$(cat /opt/rocm/.info/version 2>/dev/null | head -n1)
    [ -n "$ver" ] && { echo "ROCm $ver"; return; }

    # Try rocm-smi
    ver=$(rocm-smi --version 2>/dev/null | awk '/ROCm/ {print $NF; exit}')
    [ -n "$ver" ] && { echo "$ver"; return; }

    # Try package manager
    ver=$(dpkg -l 2>/dev/null | awk '/rocm-core/ {print $3; exit}')
    [ -z "$ver" ] && ver=$(rpm -q --qf '%{VERSION}' rocm-core 2>/dev/null)
    [ -n "$ver" ] && { echo "ROCm $ver"; return; }

    # Fall back to kernel module
    get_driver_version "amdgpu"
}

get_amd_vram() {
    local card_path="$1"
    local real_device_path
    real_device_path=$(readlink -f "$card_path/device")

    # Try sysfs VRAM total (bytes) — most reliable on amdgpu
    local vram_bytes=""
    for f in \
        "$real_device_path/mem_info_vram_total" \
        "$card_path/device/mem_info_vram_total"; do
        if [ -r "$f" ]; then
            vram_bytes=$(cat "$f" 2>/dev/null)
            break
        fi
    done

    if [ -n "$vram_bytes" ] && [ "$vram_bytes" -gt 0 ] 2>/dev/null; then
        echo $(( vram_bytes / 1024 / 1024 )) MiB
    fi
}

get_intel_vram() {
    local card_path="$1"
    local real_device_path
    real_device_path=$(readlink -f "$card_path/device")

    # Dedicated VRAM via sysfs (Intel Arc, etc.)
    for f in \
        "$real_device_path/drm/$(basename $card_path)/gt/gt0/mem_info_vram_total" \
        "$real_device_path/mem_info_vram_total"; do
        if [ -r "$f" ]; then
            local bytes
            bytes=$(cat "$f" 2>/dev/null)
            if [ -n "$bytes" ] && [ "$bytes" -gt 0 ] 2>/dev/null; then
                echo "$(( bytes / 1024 / 1024 )) MiB"
                return
            fi
        fi
    done

    # Integrated Intel: stolen/GTT memory from lspci, normalize to MiB
    local slot
    slot=$(basename "$real_device_path")
    local raw
    raw=$(lspci -s "$slot" -v 2>/dev/null | awk '/Memory at|prefetchable/ && /size=/ {
        match($0, /size=([0-9]+[KMG])/, a); if (a[1]) { print a[1]; exit }
    }')

    if [ -n "$raw" ]; then
        local num unit
        num=$(echo "$raw" | tr -d 'KMG')
        unit=$(echo "$raw" | tr -d '0-9')
        case "$unit" in
            K) echo "$(( num / 1024 )) MiB" ;;
            M) echo "${num} MiB" ;;
            G) echo "$(( num * 1024 )) MiB" ;;
        esac
    fi
}

# Declare the associative array (hashmap) globally
declare -A gpu_map

map_pci_to_primary() {
    # Iterate over all card nodes in /sys/class/drm
    # We filter for 'card*' to ignore 'renderD*' nodes for the primary map
    for card_path in /sys/class/drm/card*; do
        
        # logical check to ensure the glob matched a file
        [ -e "$card_path" ] || continue

        # Resolve the symlink to the actual PCI device directory
        # Example result: /sys/devices/pci0000:00/.../0000:03:00.0
        real_device_path=$(readlink -f "$card_path/device")
        
        # The last part of that path is the PCI ID (e.g., 0000:03:00.0)
        pci_id=$(basename "$real_device_path")
        
        # The last part of the card_path is the card name (e.g., card0)
        card_name=$(basename "$card_path")
        
        # Store in the hashmap
        # Key: PCI ID, Value: /dev/dri/cardX
        gpu_map["$pci_id"]="/dev/dri/$card_name"
    done
}

# Function to check for other GPUs (AMD, Intel, etc.) via lspci
get_generic_gpus() {
    # Check if lspci is available
    if ! command -v lspci &> /dev/null; then
        return
    fi

    map_pci_to_primary
    # Iterate over VGA and 3D controllers
    lspci -mm -n -d ::0300 | while read -r line; do process_pci_line "$line"; done
    lspci -mm -n -d ::0302 | while read -r line; do process_pci_line "$line"; done
}

process_pci_line() {
    line="$1"
    
    slot=$(echo "$line" | awk '{print $1}')
    vendor_id_hex=$(echo "$line" | awk '{print $3}' | tr -d '"')
    
    # We want to exclude NVIDIA here if we already handled them via nvidia-smi.
    if [[ "$vendor_id_hex" == "10de" ]] && command -v nvidia-smi &> /dev/null; then
        return
    fi
    
    # Get human readable name
    full_info=$(lspci -s "$slot" -vmm)
    vendor_name=$(echo "$full_info" | grep "^Vendor:" | cut -f2-)
    device_name=$(echo "$full_info" | grep "^Device:" | cut -f2-)
    
    description="$vendor_name $device_name"
    pci_id="0000:$slot" 
    
    # Determine driver
    driver=""
    if [[ "$vendor_id_hex" == "1002" ]]; then # AMD
        driver="amdgpu"
    elif [[ "$vendor_id_hex" = "8086" ]]; then # Intel
        driver="intel"
    fi

    device_id=""
    card_path=""
    if [ -n "${gpu_map[$pci_id]}" ]; then
        # Get device id from /sys/class/drm map
        device_id="${gpu_map[$pci_id]}" # e.g. /dev/dri/card0
        # Reconstruct sysfs card path from the device path
        # device_id is /dev/dri/cardX, we want /sys/class/drm/cardX
        card_name=$(basename "$device_id")
        card_path="/sys/class/drm/$card_name"
    else
        # If it can't be found, default to pci id
        device_id="${pci_id}"
    fi
    
    local devices=()
    local binds=()
    local cap_add=()
    local group_add=()
    local ipc_mode="null"
    local shm_size="null"
    local security_opt="null"

    # Only perform detailed checks if we found the card path
    if [ -n "$card_path" ] && [ -e "$card_path" ]; then
        
        # Resolve real device path for getting sibling render node
        local real_device_path=$(readlink -f "$card_path/device")
        local render_name=""
        if [ -d "$real_device_path/drm" ]; then
             render_name=$(ls "$real_device_path/drm" | grep "^renderD" | head -n 1)
        fi

        case "$vendor_id_hex" in
            "1002") # AMD (0x1002)
                local amd_driver_version
                amd_driver_version=$(get_amd_driver_version)
                local amd_memory_total
                amd_memory_total=$(get_amd_vram "$card_path")

                # Devices
                if [ -e "/dev/dxg" ]; then
                    devices+=("/dev/dxg")
                else
                    devices+=("/dev/kfd")
                fi
                [ -n "$render_name" ] && devices+=("/dev/dri/$render_name")
                devices+=("$device_id") # /dev/dri/cardX

                # Binds
                [ -e "/opt/rocm/lib/libhsa-runtime64.so.1" ] && \
                     binds+=("/opt/rocm/lib/libhsa-runtime64.so.1:/opt/rocm/lib/libhsa-runtime64.so.1")

                # Configs
                cap_add+=("SYS_PTRACE")
                ipc_mode="\"host\""
                shm_size="8589934592"
                # SecurityOpt is a JSON object
                security_opt='{"seccomp": "unconfined"}'
                ;;
            
            "8086") # Intel (0x8086)
                local intel_driver_version
                intel_driver_version=$(get_intel_driver_version)
                local intel_memory_total
                intel_memory_total=$(get_intel_vram "$card_path")

                 # Devices
                 [ -n "$render_name" ] && devices+=("/dev/dri/$render_name")
                 devices+=("$device_id")

                 # Configs
                 group_add+=("video" "render")
                 cap_add+=("SYS_ADMIN")
                ;;
        esac
    else
        # Fallback if we don't have the card path mapped, but still want to add the primary device if applicable
        # This preserves behavior for devices that might not map correctly but are enumerated
         if [[ "$vendor_id_hex" == "1002" ]] || [[ "$vendor_id_hex" == "8086" ]]; then
              if [[ "$device_id" == /dev/* ]]; then
                  devices+=("$device_id")
              fi
         fi
    fi


    # --- Construct JSON ---
    
    # Helper to convert bash arrays using jq 
    # (re-using the logic, but localized vars)
    json_devices=$(printf '%s\n' "${devices[@]}" | jq -R . | jq -s . | jq 'map(select(length > 0))')
    json_binds=$(printf '%s\n' "${binds[@]}" | jq -R . | jq -s . | jq 'map(select(length > 0))')
    json_cap=$(printf '%s\n' "${cap_add[@]}" | jq -R . | jq -s . | jq 'map(select(length > 0))')
    json_group=$(printf '%s\n' "${group_add[@]}" | jq -R . | jq -s . | jq 'map(select(length > 0))')

    # If Devices array is empty, ensure at least the ID we found is there (unless it was already added)
    # Using 'index' to check if device_id is present is tricky with jq on the fly, 
    # but standardizing on what we found is safer. 
    # If the detailed logic above didn't populate devices (e.g. unknown vendor), we fall back to just the ID.
    if [ "$(echo "$json_devices" | jq length)" -eq 0 ]; then
         json_devices="[\"$device_id\"]"
    fi

    local driver_version=""
    local memory_total=""
    case "$vendor_id_hex" in
        "1002") driver_version="$amd_driver_version"; memory_total="$amd_memory_total" ;;
        "8086") driver_version="$intel_driver_version"; memory_total="$intel_memory_total" ;;
    esac
    jq -c -n \
        --arg desc "$description" \
        --arg driver "$driver" \
        --arg device_id "$device_id" \
        --arg driver_version "$driver_version" \
        --arg memory_total "$memory_total" \
        --argjson dev "$json_devices" \
        --argjson bind "$json_binds" \
        --argjson cap "$json_cap" \
        --argjson group "$json_group" \
        --argjson sec "$security_opt" \
        --argjson shm "$shm_size" \
        --argjson ipc "$ipc_mode" \
        '{
            description: $desc,
            init: {
                deviceRequests: {
                    Driver: (if $driver != "" then $driver else null end),
                    Devices: $dev,
                    Capabilities: [["gpu"]],
                    DriverVersion: $driver_version,
                    MemoryTotal: $memory_total
                },
                Binds: $bind,
                CapAdd: $cap,
                GroupAdd: $group,
                SecurityOpt: $sec,
                ShmSize: $shm,
                IpcMode: $ipc
            }
        } | del(.. | select(. == null)) | del(.. | select(. == []))'
}

# Function to get all GPUs in JSON array format
get_all_gpus_json() {
    (
        get_nvidia_gpus
        get_generic_gpus
    ) | jq -s '
        group_by(.description) | map(
            {
                id: (.[0].description | ascii_downcase | gsub("[^a-z0-9]"; "-") | gsub("-+"; "-") | sub("^-"; "") | sub("-$"; "")),
                description: .[0].description,
                type: "gpu",
                total: length,
                driverVersion: (.[0].init.deviceRequests.DriverVersion // .[0].driverVersion // null),
                memoryTotal: (.[0].init.deviceRequests.MemoryTotal // .[0].memoryTotal // null),
                platform: (if .[0].init.deviceRequests.Driver == "amdgpu" then "amd" else .[0].init.deviceRequests.Driver end),
                init: (
                    if .[0].init.deviceRequests.Driver == "nvidia" then
                    {
                        deviceRequests: {
                            Driver: .[0].init.deviceRequests.Driver,
                            DeviceIDs: (map(.init.deviceRequests.Devices[]?) | unique),
                            Capabilities: [["gpu"]]
                        }
                    }
                    else
                    {
                        advanced: {
                            Driver: .[0].init.deviceRequests.Driver,
                            Devices: (map(.init.deviceRequests.Devices[]?) | unique),
                            Capabilities: [["gpu"]],
                            Binds: (map(.init.Binds[]?) | unique),
                            CapAdd: (map(.init.CapAdd[]?) | unique),
                            GroupAdd: (map(.init.GroupAdd[]?) | unique),
                            SecurityOpt: .[0].init.SecurityOpt,
                            ShmSize: .[0].init.ShmSize,
                            IpcMode: .[0].init.IpcMode
                        } | del(.. | select(. == null)) | del(.. | select(. == []))
                    }
                    end
                )
            } | del(.. | select(. == null)) | del(.. | select(. == []))
        )
    '
}

# Main execution only if script is not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    get_all_gpus_json
fi
