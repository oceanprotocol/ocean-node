import React from 'react'
import styles from './index.module.css'
import DownloadLogs from '../Admin/DownloadLogs'
import StopNode from '../Admin/StopNode'
import { useAdminContext } from '@/context/AdminProvider'

export default function AdminActions() {
  const { generateSignature, signature, validTimestamp } = useAdminContext()

  return (
    <div className={styles.root}>
      <div className={styles.title}>ADMIN ACTIONS</div>

      {(!signature || !validTimestamp) && (
        <button type="button" className={styles.unlockButton} onClick={generateSignature}>
          Unlock
        </button>
      )}
      {signature && validTimestamp && (
        <>
          <DownloadLogs />
          <StopNode />
        </>
      )}
    </div>
  )
}
