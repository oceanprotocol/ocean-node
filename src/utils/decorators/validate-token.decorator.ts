import { P2PCommandResponse } from '../../@types'

/**
 * This decorator validates the token or signature of the request
 * You can use it by adding @ValidateTokenOrSignature above the handler method
 * @param skipValidation - If true, the validation will be skipped. You can also pass a function that returns a boolean.
 */
export function ValidateTokenOrSignature(
  skipValidation?: boolean | (() => Promise<boolean>)
) {
  return function (
    _target: Object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<P2PCommandResponse>>
  ) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args: any[]): Promise<P2PCommandResponse> {
      let shouldSkip = skipValidation
      if (typeof skipValidation === 'function') {
        shouldSkip = await skipValidation()
      }

      if (shouldSkip) {
        return originalMethod.apply(this, args)
      }

      const task = args[0]
      const { authorization, signature, message } = task
      const address = task.address || task.publisherAddress
      const jwt = authorization?.includes('Bearer')
        ? authorization.split(' ')[1]
        : authorization
      const oceanNode = this.getOceanNode()

      const auth = oceanNode.getAuth()
      const isAuthRequestValid = await auth.validateAuthenticationOrToken({
        token: jwt,
        signature,
        message,
        address
      })
      if (!isAuthRequestValid.valid) {
        console.log(
          `Error validating token or signature while executing command: ${task.command}`
        )
        return {
          status: {
            httpStatus: 401,
            error: 'Invalid token or signature'
          },
          stream: null
        }
      }

      return await originalMethod.apply(this, args)
    }

    return descriptor
  }
}
