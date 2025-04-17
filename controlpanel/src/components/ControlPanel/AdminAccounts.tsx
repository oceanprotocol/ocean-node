import styles from './index.module.css'
import { useAdminContext } from '@/context/AdminProvider'

export default function AdminAccounts() {
  const { allAdmins } = useAdminContext()

  return (
    <div className={styles.indexer}>
      <div className={styles.title29}>Admin Accounts</div>
      <div className={styles.provider}>
        {allAdmins.map((admin, i) => {
          return (
            <div className={styles.providerRow} key={i}>
              {admin}
            </div>
          )
        })}
      </div>
    </div>
  )
}
