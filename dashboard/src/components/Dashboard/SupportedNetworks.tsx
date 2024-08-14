import styles from './index.module.css'
import { NodeDataType } from '@Types/dataTypes'

export default function SupportedStorage({ data }: { data: NodeDataType | undefined }) {
  return (
    <div className={styles.indexer}>
      <div className={styles.title29}>SUPPORTED Networks</div>
      <div className={styles.provider}>
        {data?.provider.map((item) => {
          return (
            <div className={styles.providerRow}>
              <div className={styles.providerTitle}>
                <b>{item.chainId}</b>
              </div>
              <div>{item.network} </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
