import { BroadcastCommand } from '../../utils/constants.js'
import { LOG_LEVELS_STR, getLoggerLevelEmoji } from '../../utils/logging/Logger.js'
import { P2P_LOGGER } from '../../utils/logging/common.js'

export function handleBroadcasts(topic: string, _message: any) {
  // can only register one handler for the protocol

  if (_message.detail.topic === topic) {
    // 'broadcast from ', _message.detail.from
    P2P_LOGGER.logMessage('Received broadcast msg... ', true)
    const rawMessage = new TextDecoder('utf8').decode(_message.detail.data)
    P2P_LOGGER.logMessageWithEmoji(
      `Decoded broadcast: ${rawMessage}`,
      true,
      getLoggerLevelEmoji(LOG_LEVELS_STR.LEVEL_INFO),
      LOG_LEVELS_STR.LEVEL_INFO
    )

    const command: BroadcastCommand = JSON.parse(rawMessage) as BroadcastCommand

    P2P_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_WARN,
      `Broadcast command "${command.command}" not implemented yet!`,
      true
    )
  } else {
    // console.log('Got some relays...', message.detail)
  }
}
