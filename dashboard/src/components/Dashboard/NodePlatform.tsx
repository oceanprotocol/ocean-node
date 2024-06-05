import styles from './index.module.css'

export default function NodePlatform({
  platformData
}: {
  platformData: { key: string; value: string | number }[]
}) {
  return (
    <div className={styles.indexer}>
      <div className={styles.title29}>PLATFORM</div>
      <div className={styles.provider}>
        {platformData.map((item) => {
          return (
            <div className={styles.providerRow} key={item.value}>
              <div className={styles.providerTitle}>
                <b>{item.key}:</b>
              </div>
              <div>{item.value} </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
