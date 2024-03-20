import React, { useCallback, useState } from 'react'

import styles from './index.module.css'

export default function DownloadButton() {
  const [isLoading, setLoading] = useState(false)
  const stopNode = useCallback(() => {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      fetch(apiUrl, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          command: 'status'
        })
      })
        .then((res) => res.json())
        .then((data: any) => {
          console.log('data response:  ', data)
          setLoading(false)
        })
    } catch (error) {
      console.log('error', error)
    }
    setLoading(false)
  }, [])

  const Spinner = () => {
    return <span className={styles.loader}></span>
  }

  return (
    <button type="button" className={styles.download} onClick={stopNode}>
      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <div>Stop Node</div>
        </>
      )}
    </button>
  )
}
