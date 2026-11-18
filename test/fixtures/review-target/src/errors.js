export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(code, message) {
    super(code, message);
    this.name = 'ValidationError';
  }
}

export class AccessDeniedError extends AppError {
  constructor(message) {
    super('access_denied', message);
    this.name = 'AccessDeniedError';
  }
}
