import React, { useCallback, useState } from 'react'
import Image from 'next/image'

import styles from './index.module.css'

import DownloadSVG from '../../assets/download.svg'
import Chevron from '../../assets/chevron.svg'

export default function DownloadButton() {
  const [showFilters, setShowFilters] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [maxLogs, setMaxLogs] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [level, setLevel] = useState('')

  const downloadLogs = useCallback(async () => {
    const startDateParam = startDate ? `&startTime=${startDate}` : ''
    const endDateParam = endDate ? `&endTime=${endDate}` : ''
    const maxLogsParam = maxLogs ? `&maxLogs=${maxLogs}` : ''
    const moduleNameParam = moduleName ? `&moduleName=${moduleName}` : ''
    const levelParam = level ? `&level="${level}"` : ''

    setLoading(true)
    try {
      const data = await fetch(
        `/logs?${startDateParam}${endDateParam}${maxLogsParam}${moduleNameParam}${levelParam}`,
        {
          headers: {
            'Content-Type': 'application/json'
          },
          method: 'GET'
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

  const Spinner = () => {
    return <span className={styles.loader}></span>
  }

  return (
    <div className={styles.column}>
      <button
        type="button"
        className={styles.download}
        onClick={() => handleFiltersDropdown(showFilters)}
      >
        <div>Logs</div>
        <Image src={Chevron} alt="download button" width={20} height={20} />
      </button>

      {showFilters && (
        <div className={styles.filters}>
          <div className={styles.column}>
            <label htmlFor="startTime">Start Time</label>
            <input
              className={styles.input}
              name="startTime"
              type="datetime-local"
              id="startTime"
              onChange={(e) => {
                console.log('start', e.target.value)
                setStartDate(e.target.value)
              }}
              defaultValue={startDate}
            />
          </div>
          <div className={styles.column}>
            <label htmlFor="endTime">End Time</label>
            <input
              className={styles.input}
              name="endTime"
              type="datetime-local"
              id="endTime"
              onChange={(e) => {
                setEndDate(e.target.value)
              }}
              defaultValue={endDate}
            />
          </div>
          <div className={styles.column}>
            <label htmlFor="maxLogs">Max Logs</label>
            <input
              className={styles.input}
              name="maxLogs"
              type="number"
              id="maxLogs"
              onChange={(e) => {
                setMaxLogs(e.target.value)
              }}
            />
          </div>
          <div className={styles.column}>
            <label htmlFor="moduleName">Module Name</label>
            <input
              className={styles.input}
              name="moduleName"
              type="text"
              id="moduleName"
              onChange={(e) => {
                setModuleName(e.target.value)
              }}
            />
          </div>
          <div className={styles.column}>
            <label htmlFor="level">Level</label>
            <input
              className={styles.input}
              name="level"
              type="text"
              id="level"
              value={level}
              onChange={(e) => {
                setLevel(e.target.value)
              }}
            />
          </div>
          <button
            type="button"
            className={styles.download}
            onClick={() => downloadLogs()}
          >
            <div>Download</div>
            {isLoading ? (
              <Spinner />
            ) : (
              <Image src={DownloadSVG} alt="download button" width={24} height={24} />
            )}
          </button>
        </div>
      )}
    </div>
  )
}
