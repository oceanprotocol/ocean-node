export interface PolicyServerResult {
  success: boolean // true - allowed, false not allowed
  message?: string // error message, if any
  httpStatus?: number // status returned by server
}

export interface PolicyServerTask {
  sessionId?: string
  successRedirectUri?: string
  errorRedirectUri?: string
  responseRedirectUri?: string
  presentationDefinitionUri?: string
}
