import React from 'react'

import styles from './index.module.css'

import ErrorSVG from '../../assets/error.svg'
import NoErrorSVG from '../../assets/no-error.svg'
import Image from 'next/image'

export default function ErrorCheck({ status }: { status: string }) {
  return (
    <div className={styles.root}>
      {status === 'None' ? (
        <Image src={NoErrorSVG} alt="no error" />
      ) : (
        <Image src={ErrorSVG} alt="error" />
      )}
    </div>
  )
}
