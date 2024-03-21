import React from 'react'

import styles from './Menu.module.css'

import DownloadLogs from '../Admin/DownloadLogs'
import StopNode from '../Admin/StopNode'
import { useAdminContext } from '@/context/AdminProvider'

export default function AdminActions() {
  const { generateSignature, signature, expiryTimestamp } = useAdminContext()

  return (
    <div className={styles.root}>
      <div className={styles.title}>ADMIN ACTIONS</div>

      {(!signature || !expiryTimestamp) && (
        <button type="button" className={styles.download} onClick={generateSignature}>
          Unlock
        </button>
      )}
      {signature && expiryTimestamp && (
        <>
          <DownloadLogs />
          <StopNode />
        </>
      )}
    </div>
  )
}
