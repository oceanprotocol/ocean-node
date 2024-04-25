import React, { useCallback, useState } from 'react'
import Image from 'next/image'
import { useAdminContext } from '@context/AdminProvider'
import {
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel
} from '@mui/material'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'
import { LocalizationProvider, DateTimePicker } from '@mui/x-date-pickers'
import dayjs, { Dayjs } from 'dayjs'

import DownloadSVG from '../../assets/download.svg'
import styles from './index.module.css'

export default function DownloadButton() {
  const [showFilters, setShowFilters] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [startDate, setStartDate] = useState<Dayjs | null>(dayjs())
  const [endDate, setEndDate] = useState<Dayjs | null>(dayjs())
  const [maxLogs, setMaxLogs] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [level, setLevel] = useState('')
  const { signature, expiryTimestamp } = useAdminContext()

  const downloadLogs = useCallback(async () => {
    const startDateParam = startDate ? `&startTime=${startDate.toISOString()}` : ''
    const endDateParam = endDate ? `&endTime=${endDate.toISOString()}` : ''
    const maxLogsParam = maxLogs ? `&maxLogs=${maxLogs}` : ''
    const moduleNameParam =
      moduleName && moduleName !== 'all' ? `&moduleName=${moduleName}` : ''
    const levelParam = level && level !== 'all' ? `&level="${level}"` : ''

    setLoading(true)
    try {
      if (!expiryTimestamp || !signature) {
        console.error('Missing expiryTimestamp or signature')
        return
      }
      const response = await fetch(
        `/logs?${startDateParam}${endDateParam}${maxLogsParam}${moduleNameParam}${levelParam}`,
        {
          headers: {
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({ expiryTimestamp, signature })
        }
      )
      const data = await response.json()
      if (data) {
        const dataStr =
          'data:application/json;charset=utf-8,' +
          encodeURIComponent(JSON.stringify(data))
        const download = document.createElement('a')
        download.setAttribute('href', dataStr)
        download.setAttribute('download', 'LogsData.json')
        document.body.appendChild(download)
        download.click()
        download.remove()
      }
      setLoading(false)
    } catch (error) {
      console.error(error)
      setLoading(false)
    }
  }, [startDate, endDate, maxLogs, moduleName, level])

  return (
    <div className={styles.column}>
      <Button type="button" onClick={() => setShowFilters(!showFilters)}>
        Download Logs
      </Button>

      {showFilters && (
        <div className={styles.filters}>
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <FormControl fullWidth margin="normal">
              <DateTimePicker
                label="Start Date"
                value={startDate}
                onChange={(newDate) => setStartDate(newDate)}
              />
            </FormControl>
            <FormControl fullWidth margin="normal">
              <DateTimePicker
                label="End Date"
                value={endDate}
                onChange={(newDate) => setEndDate(newDate)}
              />
            </FormControl>
          </LocalizationProvider>
          <TextField
            label="Max Logs"
            type="number"
            value={maxLogs}
            onChange={(e) => setMaxLogs(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <FormControl fullWidth margin="normal">
            <InputLabel id="select-module-name-label">Module Name</InputLabel>
            <Select
              labelId="select-module-name-label"
              label="Module Name"
              id="module-name"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
            >
              <MenuItem value="all">all</MenuItem>
              <MenuItem value="http">http</MenuItem>
              <MenuItem value="p2p">p2p</MenuItem>
              <MenuItem value="indexer">indexer</MenuItem>
              <MenuItem value="reindexer">reindexer</MenuItem>
              <MenuItem value="provider">provider</MenuItem>
              <MenuItem value="database">database</MenuItem>
              <MenuItem value="config">config</MenuItem>
              <MenuItem value="core">core</MenuItem>
              <MenuItem value="OceanNode">OceanNode</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth margin="normal">
            <InputLabel id="select-level-label">Level</InputLabel>
            <Select
              labelId="select-level-label"
              label="Level"
              id="level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <MenuItem value="all">all</MenuItem>
              <MenuItem value="error">error</MenuItem>
              <MenuItem value="warn">warn</MenuItem>
              <MenuItem value="info">info</MenuItem>
              <MenuItem value="http">http</MenuItem>
              <MenuItem value="verbose">verbose</MenuItem>
              <MenuItem value="debug">debug</MenuItem>
              <MenuItem value="silly">silly</MenuItem>
            </Select>
          </FormControl>

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
