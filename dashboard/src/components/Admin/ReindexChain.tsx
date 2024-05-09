import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'
import NetworkSelector from '../shared/NetworkSelector'

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
          <NetworkSelector chainId={chainId} setChainId={setChainId} />

          <Button type="button" onClick={reIndex} variant="outlined" disabled={isLoading}>
            ReIndex Chain
          </Button>
        </div>
      )}
    </div>
  )
}
