// Add all the supported commands
export const PROTOCOL_COMMANDS = {
  DOWNLOAD_URL: 'downloadURL',
  ECHO: 'echo',
  GET_DDO: 'getDDO',
  NONCE: 'nonce'
}

export interface Command {
  command: string
  node?: string // if not present it means current node
}

export interface DownloadCommand extends Command {
  url: string
  aes_encrypted_key?: string // if not present it means download without encryption
}

export interface GetDdoCommand extends Command {
  id: string
}

export interface NonceCommand extends Command {
  address: string // consumer address
}

export const SUPPORTED_PROTOCOL_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.DOWNLOAD_URL,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.NONCE
]

export const SUPPORTED_NETWORK_NAMES_BY_CHAIN_IDS: any = {
  '1': 'eth',
  '10': 'optimism',
  '56': 'bsc',
  '100': 'gen-x-testnet',
  '137': 'polygon',
  '246': 'energyweb',
  '1285': 'moonriver',
  '3141': 'filecointestnet',
  '23294': 'oasis_saphire',
  '23295': 'oasis_saphire_testnet',
  '44787': 'alfajores',
  '80001': 'mumbai',
  '2021000': 'gaiaxtestnet',
  '11155111': 'sepolia',
  '11155420': 'optimism_sepolia'
}
