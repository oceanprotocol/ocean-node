// Add all the supported commands
export const DIRECT_COMMANDS = {
  DOWNLOAD_URL: 'downloadURL',
  ECHO: 'echo',
  NONCE: 'nonce',
  FIND_DDO: 'findDDO'
}

export interface BroadcastCommand {
  command: string // the name of the command
  message: any // the message to broadcast
}

export interface Command {
  command: string
  node?: string // if not present it means current node
}

export interface DownloadCommand extends Command {
  url: string
  aes_encrypted_key?: string // if not present it means download without encryption
}

export interface NonceCommand extends Command {
  address: string // consumer address
}

export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  DIRECT_COMMANDS.DOWNLOAD_URL,
  DIRECT_COMMANDS.ECHO,
  DIRECT_COMMANDS.NONCE,
  DIRECT_COMMANDS.FIND_DDO
]
