import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'
import { TextField } from '@mui/material'
import NetworkSelector from '../shared/NetworkSelector'

export default function ReIndexTransaction() {
  const [showChainInput, setShowChainInput] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [chainId, setChainId] = useState<string>()
  const [txId, setTxId] = useState<string>()
  const { signature, expiryTimestamp } = useAdminContext()

  async function reIndexTx() {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      if (expiryTimestamp && signature && chainId && txId) {
        const response = await fetch(apiUrl, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({
            command: 'reindexTx',
            chainId,
            txId,
            expiryTimestamp,
            signature
          })
        })
        if (response.status === 200) {
          alert(
            `Transaction with TX ID ${txId} on chain ${chainId} is now being reindexed.`
          )
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
        ReIndex Transaction
      </Button>

      {showChainInput && (
        <div className={styles.filters}>
          <NetworkSelector chainId={chainId} setChainId={setChainId} />
          <TextField
            label="Transaction ID"
            value={txId}
            onChange={(e) => setTxId(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <Button
            type="button"
            onClick={reIndexTx}
            variant="outlined"
            disabled={isLoading}
          >
            ReIndex Transaction
          </Button>
        </div>
      )}
    </div>
  )
}
