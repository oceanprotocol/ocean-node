import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'

export default function StopNode() {
  const [isLoading, setLoading] = useState(false)
  const { generateSignature, signMessageObject } = useAdminContext()

  async function stopNode() {
    setLoading(true)
    try {
      await generateSignature()
      console.log('signMessageObject:  ', signMessageObject)
      const apiUrl = '/directCommand'
      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          command: 'status'
        })
      })
      const data = await response.json()
      console.log('data response:  ', data)
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
