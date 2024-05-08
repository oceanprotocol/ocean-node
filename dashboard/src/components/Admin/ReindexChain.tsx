import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'
import { TextField } from '@mui/material'

export default function ReIndexChain() {
  const [showChainInput, setShowChainInput] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [chainId, setChainId] = useState<string>()
  const { signature, expiryTimestamp } = useAdminContext()

  async function reIndex() {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      if (expiryTimestamp && signature && chainId) {
        await fetch(apiUrl, {
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
        alert(`Chain with ID ${chainId} is now being reindexed.`)
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
          <TextField
            label="Chain ID"
            type="number"
            value={chainId}
            onChange={(e) => setChainId(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <Button type="button" onClick={reIndex} variant="outlined" disabled={isLoading}>
            ReIndex Chain
          </Button>
        </div>
      )}
    </div>
  )
}
