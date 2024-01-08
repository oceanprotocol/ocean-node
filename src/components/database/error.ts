export class DatabaseError extends Error {
  message: string
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
    this.name = new.target.name
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
