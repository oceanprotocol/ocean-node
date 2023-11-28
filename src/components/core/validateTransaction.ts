interface ValidateTransactionResponse {
  isValid: boolean
  message: string
}

// Mock function to validate the payment transaction for a download.
// This function always returns true for now as a placeholder.
export function validateOrderTransaction(
  transactionId: string
): ValidateTransactionResponse {
  // TODO: use `transactionId` to check the transaction on chain.
  // Since this is a mock, we assume the transaction is always valid.
  return {
    isValid: true,
    message: 'Transaction is valid.'
  }
}
