// Add all the supported commands
export const PROTOCOL_COMMANDS = {
  DOWNLOAD_URL: 'downloadURL',
  ECHO: 'echo',
  GET_DDO: 'getDDO'
}

export type DownloadCommand = {
  command: string
  node?: string // if not present it means current node
  url: string
  aes_encrypted_key?: string // if not present it means download without encryption
}

export type GetDdoCommand = {
  command: string
  node?: string // if not present it means current node
  id: string
}

export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.DOWNLOAD_URL,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.GET_DDO
]
