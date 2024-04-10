import React, { ReactElement, useEffect, useState } from 'react'
import Image from 'next/image'

import styles from './index.module.css'

import IconCopy from '../../assets/copy.svg'

type CopyPropsType = {
  text: string
}

export default function Copy({ text }: CopyPropsType): ReactElement {
  const [isCopied, setIsCopied] = useState(false)

  const copyToClipboard = (text: string) => {
    const element = document.createElement('textarea')
    element.value = text
    document.body.appendChild(element)
    element.select()
    document.execCommand('copy')
    document.body.removeChild(element)
  }

  useEffect(() => {
    if (!isCopied) return

    const timeout = setTimeout(() => {
      setIsCopied(false)
    }, 1000)

    return () => clearTimeout(timeout)
  }, [isCopied])

  return (
    <div
      className={styles.action}
      onClick={() => {
        copyToClipboard(text)
        setIsCopied(true)
      }}
    >
      <Image src={IconCopy} alt="icont-copy" className={styles.icon} />
      {isCopied && <div className={styles.feedback}>Copied!</div>}
    </div>
  )
}
