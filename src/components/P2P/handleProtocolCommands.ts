import { pipe } from 'it-pipe'
import { Stream, Readable } from 'stream'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import StreamConcat from 'stream-concat'
// export function handleProtocolCommands (sourceStream:any,sinkStream:any) {

import * as fs from 'fs'

class ReadableString extends Readable {
  private sent = false

  constructor(private str: string) {
    super()
  }

  _read() {
    if (!this.sent) {
      this.push(Buffer.from(this.str))
      this.sent = true
    } else {
      this.push(null)
    }
  }
}

export async function handleProtocolCommands(connection: any) {
  console.log('Incoming connection from peer ' + connection.connection.remotePeer)
  console.log('Using ' + connection.connection.remoteAddr)
  let status = null
  const isError = false
  let task
  let statusStream
  let sendStream = null
  /* eslint no-unreachable-loop: ["error", { "ignore": ["ForInStatement", "ForOfStatement"] }] */
  for await (const chunk of connection.stream.source) {
    try {
      const str = uint8ArrayToString(chunk.subarray())
      task = JSON.parse(str)
    } catch (e) {
      status = { httpStatus: 400, error: 'Invalid command' }
      statusStream = new ReadableString(JSON.stringify(status))
      pipe(statusStream, connection.stream.sink)
      return
    }
    break
  }
  console.log('Performing task')
  console.log(task)
  switch (task.command) {
    case 'echo':
      status = { httpStatus: 200 }
      sendStream = connection.stream.source
      break
    case 'download':
      sendStream = fs.createReadStream('/var/log/syslog')
      // sendStream=fs.createReadStream("/etc/hostname")
      status = {
        httpStatus: 200,
        headers: {
          'Content-Disposition': "attachment; filename='syslog'",
          'Content-Type': 'application/text'
        }
      }
      break
    default:
      status = { httpStatus: 501, error: 'Unknown command' }
      break
  }
  statusStream = new ReadableString(JSON.stringify(status))
  if (sendStream == null) pipe(statusStream, connection.stream.sink)
  else {
    const combinedStream = new StreamConcat([statusStream, sendStream])
    pipe(combinedStream, connection.stream.sink)
  }
}
