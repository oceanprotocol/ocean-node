import cs from 'classnames'
import styles from './index.module.css'
import IndexQueue from '../IndexQueue'
import { NodeDataType } from '@Types/dataTypes'
import { Card } from '@mui/material'

export default function Indexer({ data }: { data: NodeDataType | undefined }) {
  return (
    <div className={cs([styles.indexer, styles.borderBottom])}>
      <div className={styles.title29}>INDEXER</div>
      <div className={styles.rowIndexer}>
        {data?.indexer.map((item) => {
          return (
            <Card
              key={item.block}
              className={cs([styles.indexBlock, item.delayed && styles.delayed])}
              sx={{
                marginBottom: 4,
                borderRadius: '8px',
                position: 'relative'
              }}
            >
              <h5>{item.network}</h5>
              <div>ChainID: {item.chainId}</div>
              <div>BLOCK: {item.block}</div>
            </Card>
          )
        })}
      </div>
      <IndexQueue />
    </div>
  )
}
