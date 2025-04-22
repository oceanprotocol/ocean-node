import cs from 'classnames'
import styles from './index.module.css'
import IndexQueue from '../IndexQueue'
import { NodeDataType } from '@Types/dataTypes'
import { Card, Grid } from '@mui/material'

export default function Indexer({ data }: { data: NodeDataType | undefined }) {
  return (
    <div className={cs([styles.indexer, styles.borderBottom])}>
      <div className={styles.title29}>INDEXER</div>
      <Grid container spacing={2}>
        {data?.indexer.map((item) => {
          return (
            <Grid item xs={12} sm={6} md={4} key={item.block}>
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
            </Grid>
          )
        })}
      </Grid>

      <IndexQueue />
    </div>
  )
}
