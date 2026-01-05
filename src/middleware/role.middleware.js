import db from '../config/knex.js';

export function requireOrgRole(requiredRole = null) {
    return async function(req, res, next) {
        const userId = req.user && req.user.id;
        const orgId = req.params.organizationId;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });
        try {
            const membership = await db('organization_memberships')
                .where({ user_id: userId, organization_id: orgId })
                .first();
            if (!membership) {
                return res.status(403).json({ message: 'Access denied: No membership found' });
            }
            const userRole = membership.role;
            if (requiredRole) {
                if (userRole !== requiredRole) {
                    return res.status(403).json({ message: 'Access denied: Insufficient role' });
                }
                return next();
            }
            const allowedRoles = ['admin', 'manager', 'owner']; // roles that have access by default
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ message: 'Access denied: Insufficient role' });
            }
            next();
        } catch (error) {
            console.error('Error checking organization role:', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
}

export function requireLibraryRole(requiredRole = null) {
    return async function(req, res, next) {
        const userId = req.user && req.user.id;
        const libraryId = req.params.libraryId;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });
        try {
            const membership = await db('library_memberships')
                .where({ user_id: userId, library_id: libraryId })
                .first();
            if (!membership) {
                return res.status(403).json({ message: 'Access denied: No membership found' });
            }
            const userRole = membership.role;
            if (requiredRole) {
                if (userRole !== requiredRole) {
                    return res.status(403).json({ message: 'Access denied: Insufficient role' });
                }
                return next();
            }
            const allowedRoles = ['admin', 'editor', 'owner'];
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ message: 'Access denied: Insufficient role' });
            }
            next();
        } catch (error) {
            console.error('Error checking library role:', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
}