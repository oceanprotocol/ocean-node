import { Select, MenuItem, InputLabel, FormControl } from '@mui/material'
import { useAdminContext } from '@/context/AdminProvider'

interface NetworkSelectorProps {
  chainId?: string
  setChainId: (chainId: string) => void
}

export default function NetworkSelector({ chainId, setChainId }: NetworkSelectorProps) {
  const { networks } = useAdminContext()

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
