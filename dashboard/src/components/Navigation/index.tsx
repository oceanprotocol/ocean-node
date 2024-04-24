import Image from 'next/image'
import logo from '../../assets/logo.svg'
import styles from './style.module.css'
import { ConnectButton } from '@rainbow-me/rainbowkit'

const NavBar = () => {
  return (
    <div className={styles.navbarParent}>
      <div className={styles.logoWrapper}>
        <Image src={logo} alt="Ocean Node Logo" priority />
      </div>
      <div className={styles.connectButtonWrapper}>
        <ConnectButton />
      </div>
    </div>
  )
}

export default NavBar
