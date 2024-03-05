import React, { useCallback, useState } from 'react'
import Image from 'next/image'

import styles from './index.module.css'

import DownloadSVG from '../../assets/download.svg'
import config from '../../../config'

export default function DownloadButton() {
  const [isLoading, setLoading] = useState(false)
  const downloadLogs = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`${config.apiRoutes.logs}`, {
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
    <button type="button" className={styles.download} onClick={downloadLogs}>
      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <div>Download logs</div>
          <Image src={DownloadSVG} alt="download button" width={20} height={20} />
        </>
      )}
    </button>
  )
}
