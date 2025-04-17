import { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'

export default function StopNode() {
  const [isLoading, setLoading] = useState(false)
  const { signature, expiryTimestamp } = useAdminContext()

  async function stopNode() {
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
            command: 'stopNode',
            expiryTimestamp,
            signature
          })
        })
      }
      alert('The node has been stopped. The control panel will no longer be displayed.')
      window.location.reload()
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
    <Button onClick={stopNode} variant="outlined" color="error">
      {isLoading ? <Spinner /> : <div>Stop Node</div>}
    </Button>
  )
}
