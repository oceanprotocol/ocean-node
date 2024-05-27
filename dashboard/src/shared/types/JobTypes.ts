/* eslint-disable no-unused-vars */
export enum CommandStatus {
  DELIVERED = 'DELIVERED', // command was delivered successfully
  PENDING = 'PENDING', // command is pending excution or still running
  FAILURE = 'FAILURE', // command execution failed
  SUCCESS = 'SUCCESS' // command execution succeeded
}
export type JobStatus = {
  command: string
  timestamp: string
  jobId: string
  status: CommandStatus
  hash: string
}
