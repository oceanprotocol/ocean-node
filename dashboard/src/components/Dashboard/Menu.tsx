import React from 'react'

import styles from './Menu.module.css'

import DownloadButton from '../DownloadButton'

export default function Menu() {
  return (
    <div className={styles.root}>
      <div className={styles.title}>STATUS ADMIN</div>
      <DownloadButton />
    </div>
  )
}
