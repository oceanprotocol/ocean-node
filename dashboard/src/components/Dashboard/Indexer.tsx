import cs from 'classnames'
import styles from './index.module.css'
import IndexQueue from '../IndexQueue'
import { NodeDataType } from '@Types/dataTypes'

export default function Indexer({ data }: { data: NodeDataType | undefined }) {
  return (
    <div className={cs([styles.indexer, styles.borderBottom])}>
      <div className={styles.title29}>INDEXER</div>
      <div className={styles.rowIndexer}>
        {data?.indexer.map((item) => {
          return (
            <div
              className={cs([styles.indexBlock, item.delayed && styles.delayed])}
              key={item.block}
            >
              <h5>{item.network}</h5>
              <div>ChainID: {item.chainId}</div>
              <div>BLOCK: {item.block}</div>
            </div>
          )
        })}
      </div>
      <IndexQueue />
    </div>
  )
}
