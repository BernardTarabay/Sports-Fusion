// Role-based access control.
//
// Roles are global or district-scoped. A district_admin runs Beirut and must not be able
// to touch a game in Keserwan. `owner` and `admin` are global.
//
// The district check needs the district of the thing being acted on, which usually means
// a database read, so requireDistrictAccess takes a resolver rather than guessing.

import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

const GLOBAL_ROLES = new Set(['admin', 'owner']);

export function hasRole(user, ...roles) {
  return user?.roles?.some((r) => roles.includes(r.role)) ?? false;
}

export function isGlobalAdmin(user) {
  return user?.roles?.some((r) => GLOBAL_ROLES.has(r.role)) ?? false;
}

export function adminDistrictIds(user) {
  return (user?.roles ?? [])
    .filter((r) => r.role === 'district_admin' && r.districtId)
    .map((r) => r.districtId);
}

/** Requires any one of the named roles. */
export function requireRoles(...roles) {
  return function roleGuard(req, _res, next) {
    if (!req.user) return next(new UnauthorizedError());
    if (!hasRole(req.user, ...roles)) {
      return next(new ForbiddenError(`Requires one of: ${roles.join(', ')}`));
    }
    return next();
  };
}

/** Any admin: global, or district admin of at least one district. */
export const requireAdmin = requireRoles('admin', 'owner', 'district_admin');

/**
 * Requires admin rights over a specific district.
 *
 * @param {(req) => Promise<string|null>|string|null} resolveDistrictId
 */
export function requireDistrictAccess(resolveDistrictId) {
  return async function districtGuard(req, _res, next) {
    try {
      if (!req.user) return next(new UnauthorizedError());
      if (isGlobalAdmin(req.user)) return next();

      const districtId = await resolveDistrictId(req);
      if (!districtId) return next(new ForbiddenError('Could not determine the district'));

      if (!adminDistrictIds(req.user).includes(districtId)) {
        return next(new ForbiddenError('You do not administer this district'));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Requires that the caller is acting on their own player record, or is an admin.
 * Stops one player cancelling another player's registration.
 */
export function requireSelfOrAdmin(resolveUserId) {
  return async function selfGuard(req, _res, next) {
    try {
      if (!req.user) return next(new UnauthorizedError());
      if (isGlobalAdmin(req.user) || hasRole(req.user, 'district_admin')) return next();

      const targetUserId = await resolveUserId(req);
      if (targetUserId !== req.user.id) {
        return next(new ForbiddenError('You can only do that for your own account'));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
