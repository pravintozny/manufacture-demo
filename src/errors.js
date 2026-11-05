export class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export class ValidationError extends AppError {
  constructor(message, details) { super(message, 400, 'VALIDATION_ERROR', details); }
}
export class NotFoundError extends AppError {
  constructor(message, details) { super(message, 404, 'NOT_FOUND', details); }
}
export class ConflictError extends AppError {
  constructor(message, details) { super(message, 409, 'CONFLICT', details); }
}
/** Raised when an operation would drive raw-material stock negative or cannot be covered by stock. */
export class StockError extends AppError {
  constructor(message, details) { super(message, 409, 'INSUFFICIENT_STOCK', details); }
}
