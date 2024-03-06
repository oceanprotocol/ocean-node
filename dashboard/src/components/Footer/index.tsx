import styles from './style.module.css'
const Footer = () => {
  const currentYear = new Date().getFullYear()
  return (
    <div className={styles.footerContainer}>
      <p>@ {currentYear}, Ocean Nodes</p>
      <div className={styles.footerLinks}>
        <a href="https://oceanprotocol.com/" target="_blank">
          Website
        </a>
        <a href="https://github.com/oceanprotocol" target="_blank">
          GitHub
        </a>
        <a href="https://oceanprotocol.com/tech-whitepaper.pdf" target="_blank">
          Whitepaper
        </a>
        <a href="https://discord.com/invite/TnXjkR5" target="_blank">
          Discord
        </a>
        <a href="https://blog.oceanprotocol.com/" target="_blank">
          Blog
        </a>
      </div>
    </div>
  )
}

export default Footer
