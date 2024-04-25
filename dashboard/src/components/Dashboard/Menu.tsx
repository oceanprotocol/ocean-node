import React from 'react'
import AdminActions from '../Admin'
import styles from './Menu.module.css'

export default function Menu() {
  return (
    <div className={styles.root}>
      <div className={styles.title}>STATUS ADMIN</div>
      <AdminActions />
    </div>
  )
}
