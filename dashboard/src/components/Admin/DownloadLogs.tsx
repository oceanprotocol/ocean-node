import React, { useCallback, useState } from 'react'
import Image from 'next/image'
import { useAdminContext } from '@context/AdminProvider'
import { Button, TextField } from '@mui/material'
import DownloadSVG from '../../assets/download.svg'
import styles from './index.module.css'

export default function DownloadButton() {
  const [showFilters, setShowFilters] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [maxLogs, setMaxLogs] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [level, setLevel] = useState('')
  const { signature, expiryTimestamp } = useAdminContext()

  const downloadLogs = useCallback(async () => {
    const startDateParam = startDate ? `&startTime=${startDate}` : ''
    const endDateParam = endDate ? `&endTime=${endDate}` : ''
    const maxLogsParam = maxLogs ? `&maxLogs=${maxLogs}` : ''
    const moduleNameParam = moduleName ? `&moduleName=${moduleName}` : ''
    const levelParam = level ? `&level="${level}"` : ''

    setLoading(true)
    try {
      if (!expiryTimestamp || !signature) {
        console.error('Missing expiryTimestamp or signature')
        return
      }
      const data = await fetch(
        `/logs?${startDateParam}${endDateParam}${maxLogsParam}${moduleNameParam}${levelParam}`,
        {
          headers: {
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({ expiryTimestamp, signature })
        }
      ).then((res) => res.json())
      if (data) {
        const dataStr =
          'data:application/json;charset=utf-8,' +
          encodeURIComponent(JSON.stringify(data))
        const download = document.createElement('a')
        download.setAttribute('href', dataStr)
        download.setAttribute('download', 'LogsData' + '.json')
        document.body.appendChild(download)
        download.click()
        download.remove()
        setLoading(false)
      }
    } catch (error) {
      console.log(error)
      setLoading(false)
    }
  }, [startDate, endDate, maxLogs, moduleName, level])

  const handleFiltersDropdown = (state: boolean) => {
    setShowFilters(!state)
  }

  return (
    <div className={styles.column}>
      <Button type="button" onClick={() => handleFiltersDropdown(showFilters)}>
        Download Logs
      </Button>

      {showFilters && (
        <div className={styles.filters}>
          <TextField
            label="Start Time"
            type="datetime-local"
            onChange={(e) => setStartDate(e.target.value)}
            defaultValue={startDate}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <TextField
            label="End Time"
            type="datetime-local"
            onChange={(e) => setEndDate(e.target.value)}
            defaultValue={endDate}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <TextField
            label="Max Logs"
            type="number"
            onChange={(e) => setMaxLogs(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <TextField
            label="Module Name"
            type="text"
            onChange={(e) => setModuleName(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <TextField
            label="Level"
            type="text"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <Button
            type="button"
            onClick={downloadLogs}
            variant="outlined"
            startIcon={
              <Image src={DownloadSVG} alt="download button" width={24} height={24} />
            }
            disabled={isLoading}
          >
            Download
          </Button>
        </div>
      )}
    </div>
  )
}
