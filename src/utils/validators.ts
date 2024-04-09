import { ConsumerParameter } from '../@types/DDO/ConsumerParameter.js'
import { ValidateParams } from '../components/httpRoutes/validateCommands.js'
import { CORE_LOGGER } from './logging/common.js'

function checkString(value: any) {
  return typeof value === 'string' || value instanceof String
}

function checkBoolean(value: any) {
  return typeof value === 'boolean' || value instanceof Boolean
}

function checkNumber(value: any) {
  return typeof value === 'number' || value instanceof Number
}

function checkObject(value: any) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateConsumerParameters(
  ddoConsumerParameters: ConsumerParameter | ConsumerParameter[],
  userSentObject: any | any[]
): ValidateParams {
  const validation: ValidateParams = {
    valid: true,
    reason: '',
    status: 200
  }

  try {
    if (!Array.isArray(userSentObject)) {
      userSentObject = [userSentObject]
    }
    if (!Array.isArray(ddoConsumerParameters)) {
      ddoConsumerParameters = [ddoConsumerParameters]
    }

    for (const consumerParameter of ddoConsumerParameters) {
      for (const sentObject of userSentObject) {
        if (!checkObject(sentObject)) {
          throw new Error(`Value is not an object`)
        }
        // check if key exists in object and if it is required or not, if not add default value
        const sentObjectKey = consumerParameter.name
        if (
          sentObject[sentObjectKey] === undefined ||
          sentObject[sentObjectKey] === null
        ) {
          if (consumerParameter.required) {
            throw new Error(`value of key ${sentObjectKey} parameter is required`)
          }
          sentObject[sentObjectKey] = consumerParameter.default
        }
        // check the value for that key
        const sentObjectValue = sentObject[sentObjectKey]
        const parameterType = consumerParameter.type // text, number, boolean or select
        let hasWrongType = false
        if (
          (parameterType === 'text' && !checkString(sentObjectValue)) ||
          (parameterType === 'number' && !checkNumber(sentObjectValue)) ||
          (parameterType === 'boolean' && !checkBoolean(sentObjectValue))
        ) {
          hasWrongType = true
        } else if (parameterType === 'select') {
          const options: any[] = consumerParameter.options.map(
            (option) => Object.keys(option)[0]
          )
          if (!options.includes(sentObjectValue)) {
            hasWrongType = true
          }
        }
        if (hasWrongType) {
          throw new Error(
            `value ${sentObjectValue} of key ${sentObjectKey} parameter has wrong type, expected: "${parameterType}", got: "${typeof sentObjectValue}`
          )
        }
      }
    }
    return validation
  } catch (error) {
    CORE_LOGGER.error(error.message)
    validation.valid = false
    validation.reason = error.message
    validation.status = 400
    return validation
  }
}
