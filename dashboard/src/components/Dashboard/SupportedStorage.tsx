import styles from './index.module.css'
import { NodeDataType } from '@Types/dataTypes'

export default function SupportedStorage({ data }: { data: NodeDataType | undefined }) {
  return (
    <div className={styles.indexer}>
      <div className={styles.title29}>SUPPORTED STORAGE</div>
      <div className={styles.provider}>
        <div className={styles.providerRow}>
          <div className={styles.providerTitle}>
            <b>arwave:</b>
          </div>
          <div>{data?.supportedStorage.arwave.toString()} </div>
        </div>
        <div className={styles.providerRow}>
          <div className={styles.providerTitle}>
            <b>ipfs:</b>
          </div>
          <div>{data?.supportedStorage.ipfs.toString()} </div>
        </div>
        <div className={styles.providerRow}>
          <div className={styles.providerTitle}>
            <b>url:</b>
          </div>
          <div>{data?.supportedStorage.url.toString()} </div>
        </div>
      </div>
    </div>
  )
}
