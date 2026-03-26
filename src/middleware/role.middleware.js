import db from '../config/knex.js';

export function requireOrgRole(requiredRole = null) {
    return async function(req, res, next) {
        const userId = req.user && req.user.id;
        // normalize params/body to avoid reading properties of undefined
        const params = req.params || {};
        const body = req.body || {};
        // accept multiple param names for flexibility
        let orgId = params.organizationId || params.orgId || params.id || body.organizationId;
        // If orgId wasn't provided, try to derive it from pieceId or libraryId
        try {
            if (!orgId) {
                const pieceId = params.pieceId || body.pieceId;
                if (pieceId) {
                    const piece = await db('pieces').where({ id: pieceId }).first();
                    if (piece && piece.library_id) {
                        const lib = await db('libraries').where({ id: piece.library_id }).first();
                        if (lib && lib.organization_id) orgId = lib.organization_id;
                    }
                }
            }
            if (!orgId) {
                const libraryId = params.libraryId || body.libraryId;
                if (libraryId) {
                    const lib = await db('libraries').where({ id: libraryId }).first();
                    if (lib && lib.organization_id) orgId = lib.organization_id;
                }
            }
        } catch (err) {
            console.error('Error deriving organizationId in middleware:', err && err.stack ? err.stack : err);
            // fall through to later error handling if we still don't have orgId
        }
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!orgId) return res.status(400).json({ message: 'organizationId parameter missing' });
        try {
            const membership = await db('organization_memberships')
                .where({ user_id: userId, organization_id: orgId })
                .first();
            if (!membership) {
                console.debug(`Access denied: no membership. userId=${userId} orgId=${orgId}`)
                return res.status(403).json({ message: 'Access denied: No membership found' });
            }
            const userRole = membership.role;

            // If requiredRole is provided, it may be a string or an array of allowed roles
            if (requiredRole) {
                if (Array.isArray(requiredRole)) {
                    if (!requiredRole.includes(userRole)) {
                        console.debug(`Access denied: insufficient role. userId=${userId} orgId=${orgId} userRole=${userRole} required=${JSON.stringify(requiredRole)}`)
                        return res.status(403).json({ message: 'Access denied: Insufficient role' });
                    }
                    return next();
                } else {
                    // string: require exact match
                    if (userRole !== requiredRole) {
                        console.debug(`Access denied: insufficient role. userId=${userId} orgId=${orgId} userRole=${userRole} required=${requiredRole}`)
                        return res.status(403).json({ message: 'Access denied: Insufficient role' });
                    }
                    return next();
                }
            }

            // Default allowed roles for organization-level access (viewing org resources)
            const allowedRoles = ['viewer', 'editor', 'manager', 'admin', 'owner'];
            if (!allowedRoles.includes(userRole)) {
                console.debug(`Access denied: insufficient role. userId=${userId} orgId=${orgId} userRole=${userRole} allowed=${JSON.stringify(allowedRoles)}`)
                return res.status(403).json({ message: 'Access denied: Insufficient role' });
            }
            next();
        } catch (error) {
            console.error('Error checking organization role:', error && error.stack ? error.stack : error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
}

export function requireLibraryRole(requiredRole = null) {
    return async function(req, res, next) {
        const userId = req.user && req.user.id;
        const params = req.params || {};
        const body = req.body || {};
        let libraryId = params.libraryId || params.id || body.libraryId;
        // If libraryId not provided, try to derive it from pieceId
        try {
            if (!libraryId) {
                const pieceId = params.pieceId || body.pieceId;
                if (pieceId) {
                    const piece = await db('pieces').where({ id: pieceId }).first();
                    if (piece && piece.library_id) libraryId = piece.library_id;
                }
            }
        } catch (err) {
            console.error('Error deriving libraryId in middleware:', err && err.stack ? err.stack : err);
        }
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!libraryId) return res.status(400).json({ message: 'libraryId parameter missing' });
        try {
            const membership = await db('library_memberships')
                .where({ user_id: userId, library_id: libraryId })
                .first();
            if (!membership) {
                console.debug(`Library access denied: no membership. userId=${userId} libraryId=${libraryId}`)
                return res.status(403).json({ message: 'Access denied: No membership found' });
            }
            const userRole = membership.role;
            if (requiredRole) {
                if (Array.isArray(requiredRole)) {
                    if (!requiredRole.includes(userRole)) {
                        console.debug(`Library access denied: insufficient role. userId=${userId} libraryId=${libraryId} userRole=${userRole} required=${JSON.stringify(requiredRole)}`)
                        return res.status(403).json({ message: 'Access denied: Insufficient role' });
                    }
                    return next();
                } else {
                    if (userRole !== requiredRole) {
                        console.debug(`Library access denied: insufficient role. userId=${userId} libraryId=${libraryId} userRole=${userRole} required=${requiredRole}`)
                        return res.status(403).json({ message: 'Access denied: Insufficient role' });
                    }
                    return next();
                }
            }
            const allowedRoles = ['admin', 'editor', 'owner'];
            if (!allowedRoles.includes(userRole)) {
                console.debug(`Library access denied: insufficient role. userId=${userId} libraryId=${libraryId} userRole=${userRole} allowed=${JSON.stringify(allowedRoles)}`)
                return res.status(403).json({ message: 'Access denied: Insufficient role' });
            }
            next();
        } catch (error) {
            console.error('Error checking library role:', error && error.stack ? error.stack : error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
}

// New: allow either a library-level membership or an organization-level membership
export function requireOrgOrLibraryRole(requiredRole = null) {
    return async function(req, res, next) {
        const userId = req.user && req.user.id;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        // derive ids
        const params = req.params || {};
        const body = req.body || {};
        let libraryId = params.libraryId || params.id || body.libraryId;
        let orgId = params.organizationId || params.orgId || params.id || body.organizationId;
        try {
            if (!libraryId) {
                const pieceId = params.pieceId || body.pieceId;
                if (pieceId) {
                    const piece = await db('pieces').where({ id: pieceId }).first();
                    if (piece && piece.library_id) libraryId = piece.library_id;
                }
            }
            if (!orgId && libraryId) {
                const lib = await db('libraries').where({ id: libraryId }).first();
                if (lib && lib.organization_id) orgId = lib.organization_id;
            }
        } catch (err) {
            console.error('Error deriving ids in requireOrgOrLibraryRole:', err && err.stack ? err.stack : err);
        }

        // Try library membership first if we have libraryId
        try {
            if (libraryId) {
                const membership = await db('library_memberships').where({ user_id: userId, library_id: libraryId }).first();
                if (membership) {
                    const userRole = membership.role;
                    if (!requiredRole) return next();
                    if (Array.isArray(requiredRole)) {
                        if (requiredRole.includes(userRole)) return next();
                    } else {
                        if (userRole === requiredRole) return next();
                    }
                    // not allowed at library level; fall through to check org
                }
            }

            // Try org membership
            if (!orgId) return res.status(400).json({ message: 'organizationId parameter missing' });
            const orgMembership = await db('organization_memberships').where({ user_id: userId, organization_id: orgId }).first();
            if (!orgMembership) {
                const body = { message: 'Access denied: No membership found' }
                if (process.env.NODE_ENV !== 'production') body.debug = { userId, orgId, libraryId }
                return res.status(403).json(body)
            }
            const orgRole = orgMembership.role;
            if (!requiredRole) return next();
            if (Array.isArray(requiredRole)) {
                if (!requiredRole.includes(orgRole)) return res.status(403).json({ message: 'Access denied: Insufficient role' });
                return next();
            } else {
                if (orgRole !== requiredRole) return res.status(403).json({ message: 'Access denied: Insufficient role' });
                return next();
            }
        } catch (err) {
            console.error('Error in requireOrgOrLibraryRole:', err && err.stack ? err.stack : err);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
}
