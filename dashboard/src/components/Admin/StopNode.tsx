import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'

export default function StopNode() {
  const [isLoading, setLoading] = useState(false)
  const { generateSignature, signature, expiryTimestamp } = useAdminContext()

  async function stopNode() {
    setLoading(true)
    try {
      generateSignature()
      console.log('stopNode signMessageObject:  ', signature)
      console.log('stopNode expiryTimestamp:  ', expiryTimestamp)
      const apiUrl = '/directCommand'
      if (expiryTimestamp && signature) {
        const response = await fetch(apiUrl, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({
            command: 'stopNode',
            expiryTimestamp,
            signature
          })
        })
        const data = await response.json()
        console.log('data response:  ', data)
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
    <button type="button" className={styles.download} onClick={stopNode}>
      {isLoading ? <Spinner /> : <div>Stop Node</div>}
    </button>
  )
}
