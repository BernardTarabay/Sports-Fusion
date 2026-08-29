// Typed application errors.
//
// Each carries an HTTP status and a stable machine-readable code, so the frontend can
// branch on `GAME_FULL` without string-matching an English sentence that a designer
// will later rewrite.

export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = status < 500;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  // `code` is overridable because some 422s are a branch the client must ACT on, not just
  // report. The frontend maps codes to copy and ignores the server's wording, so a
  // validation failure that needs specific handling has to be distinguishable by code.
  constructor(message = 'Invalid request', details, code = 'VALIDATION_ERROR') {
    super(message, { status: 422, code, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(message, { status: 401, code });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that', code = 'FORBIDDEN') {
    super(message, { status: 403, code });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT', details) {
    super(message, { status: 409, code, details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, { status: 429, code: 'RATE_LIMITED' });
  }
}

// Registration-specific conditions the UI needs to distinguish.
export const RegistrationErrors = {
  gameFull: (waitlistPosition) =>
    new ConflictError('This game is full', 'GAME_FULL', { waitlistPosition }),
  alreadyRegistered: () =>
    new ConflictError('You are already registered for this game', 'ALREADY_REGISTERED'),
  registrationClosed: () =>
    new ConflictError('Registration for this game has closed', 'REGISTRATION_CLOSED'),
  registrationNotOpen: (opensAt) =>
    new ConflictError('Registration has not opened yet', 'REGISTRATION_NOT_OPEN', { opensAt }),
  gameCancelled: () =>
    new ConflictError('This game has been cancelled', 'GAME_CANCELLED'),
  waitlistFull: () =>
    new ConflictError('The waiting list for this game is full', 'WAITLIST_FULL'),
  notRegistered: () =>
    new ConflictError('You are not registered for this game', 'NOT_REGISTERED'),
  alreadyStarted: () =>
    new ConflictError('This game has already started', 'GAME_STARTED'),
};
