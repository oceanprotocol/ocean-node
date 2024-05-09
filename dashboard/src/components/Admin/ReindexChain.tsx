import React, { useState, useEffect } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'
import { MenuItem, Select, InputLabel, FormControl } from '@mui/material'

interface Network {
  chainId: number
  network: string
  rpc: string
  chunkSize: number
}

const parseRPCs = (): Record<number, Network> => {
  const rpcsEnv = process.env.RPCS || '{}'
  return JSON.parse(rpcsEnv)
}

export default function ReIndexChain() {
  const [showChainInput, setShowChainInput] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [chainId, setChainId] = useState<string>()
  const [networks, setNetworks] = useState<Record<number, Network>>({})
  const { signature, expiryTimestamp } = useAdminContext()

  useEffect(() => {
    try {
      setNetworks(parseRPCs())
    } catch (error) {
      console.error('Error parsing RPCs:', error)
    }
  }, [])

  async function reIndex() {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      if (expiryTimestamp && signature && chainId) {
        const response = await fetch(apiUrl, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({
            command: 'reindexChain',
            chainId,
            expiryTimestamp,
            signature
          })
        })
        if (response.status === 200) {
          alert(`Chain with ID ${chainId} is now being reindexed.`)
          setShowChainInput(false)
        } else {
          alert('Error reindexing chain. Please try again.')
        }
      }
    } catch (error) {
      console.error('error', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.column}>
      <Button type="button" onClick={() => setShowChainInput(!showChainInput)}>
        ReIndex Chain
      </Button>

      {showChainInput && (
        <div className={styles.filters}>
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

          <Button type="button" onClick={reIndex} variant="outlined" disabled={isLoading}>
            ReIndex Chain
          </Button>
        </div>
      )}
    </div>
  )
}
