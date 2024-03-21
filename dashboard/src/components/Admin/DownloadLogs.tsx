import React, { useCallback, useState } from 'react'
import styles from './index.module.css'
import Button from '@mui/material/Button'

export default function DownloadLogs() {
  const [isLoading, setLoading] = useState(false)
  const downloadLogs = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`/logs`, {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'GET'
    }).then((res) => res.json())
    if (data) {
      const dataStr =
        'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data))
      const download = document.createElement('a')
      download.setAttribute('href', dataStr)
      download.setAttribute('download', 'LogsData' + '.json')
      document.body.appendChild(download)
      download.click()
      download.remove()
    }
    setLoading(false)
  }, [])

  const Spinner = () => {
    return <span className={styles.loader}></span>
  }

  return (
    <Button onClick={downloadLogs} variant="outlined">
      {isLoading ? <Spinner /> : <div>Download logs</div>}
    </Button>
  )
}
