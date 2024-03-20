import React from 'react'

import styles from './Menu.module.css'

import DownloadLogs from '../Admin/DownloadLogs'
import StopNode from '../Admin/StopNode'

export default function Menu() {
  return (
    <div className={styles.root}>
      <div className={styles.title}>STATUS ADMIN</div>
      <DownloadLogs />
      <StopNode />
    </div>
  )
}
