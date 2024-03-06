export const truncateString = (text: string | undefined, chars = 6) => {
  if (text) {
    const firstPart = text.slice(0, 2 + chars)
    const lastPart = text.slice(-chars)
    return `${firstPart}....${lastPart}`
  }
  return text
}
