import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'

export default function ReIndexChain() {
  const [isLoading, setLoading] = useState(false)
  const { signature, expiryTimestamp } = useAdminContext()

  async function reIndex() {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      if (expiryTimestamp && signature) {
        await fetch(apiUrl, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({
            command: 'reindexChain',
            chainId: '137',
            expiryTimestamp,
            signature
          })
        })
        alert('The chain is now being reindexed.')
      }
    } catch (error) {
      console.error('error', error)
    } finally {
      setLoading(false)
    }
  }

  const Spinner = () => {
    return <span className={styles.loader}></span>
  }

  return (
    <Button onClick={reIndex} variant="outlined" color="error">
      {isLoading ? <Spinner /> : <div>ReIndex Chain</div>}
    </Button>
  )
}
