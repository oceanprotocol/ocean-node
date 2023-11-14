// Add all the supported commands
export const DIRECT_COMMANDS = {
  DOWNLOAD_URL: 'downloadURL',
  ECHO: 'echo'
}

export const BROADCAST_COMMANDS = {
  FIND_DDO: 'findDDO'
}

export type DownloadCommand = {
  command: string
  node?: string // if not present it means current node
  url: string
  aes_encrypted_key?: string // if not present it means download without encryption
}

export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  DIRECT_COMMANDS.DOWNLOAD_URL,
  DIRECT_COMMANDS.ECHO,
  BROADCAST_COMMANDS.FIND_DDO
]
