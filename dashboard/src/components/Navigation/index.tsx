import Image from 'next/image'
import logo from '../../assets/logo.svg'

import styles from './style.module.css'
import { useState } from 'react'
import { ethers } from 'ethers'

const NavBar = () => {
  const [connected, setConnected] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  console.log('🚀 ~ Dashboard ~ walletAddress:', walletAddress)

  async function connectWallet() {
    if (!connected) {
      const provider = new ethers.BrowserProvider(window.ethereum)
      const signer = await provider.getSigner()
      const address = await signer.getAddress()
      setConnected(true)
      setWalletAddress(address)
    } else {
      setConnected(false)
      setWalletAddress('')
    }
  }

  return (
    <div className={styles.navbarParent}>
      <div className={styles.logoContainer}>
        <Image
          className={styles.logo}
          src={logo}
          alt="The logo of the platform, represented by a discontinued black circle and Ocean Protocol text next to it."
          priority
        />
      </div>

      <div className={styles.menuOptions}>
        <button type="button" className={styles.docButton} onClick={connectWallet}>
          {connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>
    </div>
  )
}

export default NavBar
