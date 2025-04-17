import Image from 'next/image'
import DataTable, { TableColumn } from 'react-data-table-component'

import styles from './index.module.css'
import { customStyles } from './_styles'

import NodeDetails from '../NodeDetails'
import { Data } from './data'
import ErrorCheck from '../ErrorCheck'
import { DataRowType } from '../../shared/types/RowDataType'
import DownloadSVG from '../../assets/download.svg'

export interface TableOceanColumn<T> extends TableColumn<T> {
  selector?: (row: T) => any
}

const DownloadButton = () => {
  return (
    <button className={styles.download}>
      <Image src={DownloadSVG} alt="download button" />
    </button>
  )
}

export default function Table() {
  const Columns: TableOceanColumn<DataRowType | any>[] = [
    { name: 'Node Id', selector: (row) => row.nodeId },
    { name: 'Network', selector: (row) => row.network },
    { name: 'Chain Id', selector: (row) => row.chainId },
    { name: 'Components', selector: (row) => row.components },
    { name: 'Block Number', selector: (row) => row.blockNumber },
    {
      name: 'Errors',
      selector: (row) => <ErrorCheck status={row.errors} />
    },
    { name: 'Logs', selector: () => <DownloadButton /> }
  ]

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Ocean Node Control Panel</h1>
      <DataTable
        data={Data}
        columns={Columns}
        paginationPerPage={5}
        defaultSortAsc
        expandableRows
        expandableRowsComponent={NodeDetails}
        theme="custom"
        customStyles={customStyles}
      />
    </div>
  )
}
