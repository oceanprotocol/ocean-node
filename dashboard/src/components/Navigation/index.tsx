import Image from 'next/image'
import logo from '../../assets/logo.svg'
import styles from './style.module.css'
import { ConnectButton } from '@rainbow-me/rainbowkit'

const NavBar = () => {
  return (
    <div className={styles.navbarParent}>
      <Image
        className={styles.logo}
        src={logo}
        alt="The logo of the platform."
        priority
      />
      <ConnectButton />
    </div>
  )
}

export default NavBar
