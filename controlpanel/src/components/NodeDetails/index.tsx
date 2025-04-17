import React from 'react'
import { ExpanderComponentProps } from 'react-data-table-component'
import { DataRowType } from '@Types/RowDataType'
import styles from './index.module.css'

const NodeDetails: React.FC<ExpanderComponentProps<DataRowType>> = ({ data }) => {
  const keyValuePairs = Object.keys(data.nodeDetails).map((key) => {
    // @ts-expect-error - error is shown here because the key is used as an index.
    return { key: `${key}`, value: `${data.nodeDetails[key]}` }
  })

  return (
    <div className={styles.root}>
      {keyValuePairs.map((item) => {
        return (
          <div className={styles.item} key={item.key + item.value}>
            <div className={styles.key}>{item.key}</div>
            <div className={styles.value}>{item.value}</div>
          </div>
        )
      })}
    </div>
  )
}

export default NodeDetails
