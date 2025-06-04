import { P2PCommandResponse } from '../../@types'

// This decorator validates the token or signature of the request
// You can use it by adding @ValidateTokenOrSignature above the handler method
export function ValidateTokenOrSignature() {
  return function (
    _target: Object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>
  ): TypedPropertyDescriptor<any> {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args: any[]): Promise<P2PCommandResponse> {
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
            error: 'Invalid signature'
          },
          stream: null
        }
      }

      return await originalMethod.apply(this, args)
    }

    return descriptor
  }
}
