// Request validation with zod, plus an async route wrapper.

import { ValidationError } from '../lib/errors.js';

/**
 * Validate and REPLACE req.body / req.params / req.query with the parsed result, so
 * handlers receive coerced, trimmed, known-shaped data and never the raw input.
 *
 * @param {{body?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny}} schemas
 */
export function validate(schemas) {
  return function validator(req, _res, next) {
    for (const key of ['params', 'query', 'body']) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        return next(
          new ValidationError(
            'Some of those details are not valid',
            result.error.issues.map((i) => ({
              field: i.path.join('.') || key,
              message: i.message,
            }))
          )
        );
      }
      // req.query is a getter in Express 5; assigning to a property of the existing
      // object keeps this working across both major versions.
      if (key === 'query') {
        Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
      } else {
        req[key] = result.data;
      }
    }
    return next();
  };
}

/**
 * Express 4 does not catch rejected promises from handlers -- an async handler that
 * throws produces a hung request rather than a 500. Wrapping is mandatory, not optional.
 */
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
