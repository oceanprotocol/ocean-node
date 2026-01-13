#!/usr/bin/env bash

# Function to check for NVIDIA GPUs
get_nvidia_gpus() {
    if command -v nvidia-smi &> /dev/null; then
        # Query nvidia-smi for GPU count, names, and UUIDs
        # We use csv format for easier parsing
        nvidia-smi --query-gpu=name,uuid --format=csv,noheader | while IFS=, read -r name uuid; do
            # Trim leading/trailing whitespace
            name=$(echo "$name" | xargs)
            uuid=$(echo "$uuid" | xargs)
            
            # Create a JSON object for this GPU
            # Note: We use the UUID as the ID locally, but it will be aggregated later
             jq -c -n \
                --arg name "$name" \
                --arg uuid "$uuid" \
                '{
                    description: $name,
                    init: {
                        deviceRequests: {
                            Driver: "nvidia",
                            DeviceIDs: [$uuid]
                        }
                    }
                }'
        done
    fi
}

# Function to check for other GPUs (AMD, Intel, etc.) via lspci
get_generic_gpus() {
    # Check if lspci is available
    if ! command -v lspci &> /dev/null; then
        return
    fi

    # Iterate over VGA and 3D controllers
    lspci -mm -n -d ::0300 | while read -r line; do process_pci_line "$line"; done
    lspci -mm -n -d ::0302 | while read -r line; do process_pci_line "$line"; done
}

process_pci_line() {
    line="$1"
    
    slot=$(echo "$line" | awk '{print $1}')
    vendor_id=$(echo "$line" | awk '{print $3}' | tr -d '"')
    
    # We want to exclude NVIDIA here if we already handled them via nvidia-smi.
    if [[ "$vendor_id" == "10de" ]] && command -v nvidia-smi &> /dev/null; then
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
    if [[ "$vendor_id" == "1002" ]]; then # AMD
         driver="amdgpu"
    fi

    # Construct JSON
    jq -c -n \
        --arg desc "$description" \
        --arg driver "$driver" \
        --arg pci_id "$pci_id" \
        '{
            description: $desc,
            init: {
                deviceRequests: {
                    Driver: (if $driver != "" then $driver else null end),
                    DeviceIDs: [$pci_id]
                }
            }
        }'
}

# Function to get all GPUs in JSON array format
get_all_gpus_json() {
    (
        get_nvidia_gpus
        get_generic_gpus
    ) | jq -s '
        group_by(.description) | map({
            id: (.[0].description | ascii_downcase | gsub("[^a-z0-9]"; "-") | gsub("-+"; "-") | sub("^-"; "") | sub("-$"; "")),
            description: .[0].description,
            type: "gpu",
            total: length,
            init: {
                deviceRequests: {
                    Driver: .[0].init.deviceRequests.Driver,
                    DeviceIDs: (map(.init.deviceRequests.DeviceIDs[]) | unique),
                    Capabilities: [["gpu"]]
                }
            }
        }) | map(if .init.deviceRequests.Driver == null then del(.init.deviceRequests.Driver) else . end)
    '
}

# Main execution only if script is not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    get_all_gpus_json
fi
