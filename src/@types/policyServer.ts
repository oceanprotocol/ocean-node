export interface PolicyServerResult {
  success: boolean // true - allowed, false not allowed
  message?: string // error message, if any
  httpStatus?: number // status returned by server
}
