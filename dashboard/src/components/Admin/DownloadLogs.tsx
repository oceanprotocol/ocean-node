import React, { useState } from 'react'
import styles from './index.module.css'
import Button from '@mui/material/Button'
import { useAdminContext } from '@context/AdminProvider' // Assuming the context is available

export default function DownloadLogs() {
  const [isLoading, setLoading] = useState(false)
  const { signature, expiryTimestamp } = useAdminContext()

  const Spinner = () => {
    return <span className={styles.loader}></span>
  }

  async function downloadLogs() {
    if (!expiryTimestamp || !signature) {
      console.error('Missing expiryTimestamp or signature')
      return
    }

    setLoading(true)
    try {
      const response = await fetch(`/logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expiryTimestamp, signature })
      })

      if (!response.ok) {
        throw new Error('Network response was not ok')
      }

      const data = await response.json()
      const dataStr =
        'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data))
      const download = document.createElement('a')
      download.setAttribute('href', dataStr)
      download.setAttribute('download', 'LogsData.json')
      document.body.appendChild(download)
      download.click()
      download.remove()
    } catch (error) {
      console.error('Error downloading logs:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button onClick={downloadLogs} variant="outlined">
      {isLoading ? <Spinner /> : <div>Download logs</div>}
    </Button>
  )
}
