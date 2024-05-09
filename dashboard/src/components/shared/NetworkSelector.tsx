// components/NetworkSelector.tsx
import React, { useEffect, useState } from 'react'
import { Select, MenuItem, InputLabel, FormControl } from '@mui/material'

interface Network {
  chainId: number
  network: string
  rpc: string
  chunkSize: number
}

interface NetworkSelectorProps {
  chainId?: string
  setChainId: (chainId: string) => void
}

const parseRPCs = (): Record<number, Network> => {
  const rpcsEnv = process.env.RPCS || '{}'
  return JSON.parse(rpcsEnv)
}

export default function NetworkSelector({ chainId, setChainId }: NetworkSelectorProps) {
  const [networks, setNetworks] = useState<Record<number, Network>>({})

  useEffect(() => {
    try {
      setNetworks(parseRPCs())
    } catch (error) {
      console.error('Error parsing RPCs:', error)
    }
  }, [])

  return (
    <FormControl fullWidth margin="normal" variant="outlined">
      <InputLabel id="network-select-label">Network</InputLabel>
      <Select
        labelId="network-select-label"
        id="network-select"
        value={chainId || ''}
        onChange={(e) => setChainId(e.target.value as string)}
        label="Network"
      >
        {Object.values(networks).map((network) => (
          <MenuItem key={network.chainId} value={network.chainId.toString()}>
            {network.network}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}
