import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { config, DEMO_SCHOOL_ID } from '../config/env';
import { runWithTenantContext } from '../lib/tenantContext';

export interface AuthRequest extends Request {
    user?: any;
    school_id?: string;
    branch_id?: string;
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) token = authHeader.split(' ')[1];
    if (!token) token = req.cookies?.access_token;

    if (!token) return res.status(401).json({ message: 'Authentication token missing' });

    try {
        const decoded: any = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        if (!decoded || !decoded.id) return res.status(401).json({ message: 'Invalid token payload' });

        if (decoded.is_demo === true) {
            const requestedSchoolId = (req.headers['x-school-id'] as string) ||
                (req.query.schoolId as string) || (req.query.school_id as string) ||
                (req.body?.school_id as string) || (req.body?.schoolId as string);
            if (requestedSchoolId && requestedSchoolId !== DEMO_SCHOOL_ID) {
                return res.status(403).json({ message: 'Demo tokens can only access the demo school' });
            }

            const demoSchool = await prisma.school.findUnique({ where: { id: DEMO_SCHOOL_ID } });
            const demoDbUser = await prisma.user.findUnique({
                where: { id: decoded.id },
                select: { full_name: true, avatar_url: true, phone: true },
            }).catch(() => null);

            const demoSessionRoot = (decoded.branch_id || '').split('__')[0];
            const demoHeaderBranch = req.headers['x-branch-id'] as string | undefined;
            const demoActiveBranch = (demoHeaderBranch && demoSessionRoot &&
                (demoHeaderBranch === demoSessionRoot || demoHeaderBranch.startsWith(demoSessionRoot + '__')))
                ? demoHeaderBranch : decoded.branch_id;
            const demoRoleUpper = (decoded.role || '').toUpperCase();

            req.user = {
                id: decoded.id, email: decoded.email, role: decoded.role,
                school_id: DEMO_SCHOOL_ID, branch_id: decoded.branch_id,
                allowed_branch_ids: decoded.allowed_branch_ids || [],
                active_branch_id: demoActiveBranch,
                school_generated_id: decoded.school_generated_id,
                full_name: demoDbUser?.full_name ?? decoded.full_name,
                avatar_url: demoDbUser?.avatar_url ?? null, phone: demoDbUser?.phone ?? null,
                is_demo: true,
                is_main_admin: ['ADMIN', 'PROPRIETOR', 'SUPER_ADMIN'].includes(demoRoleUpper),
                school: demoSchool, sid: decoded.sid
            };
            req.school_id = DEMO_SCHOOL_ID;
            req.branch_id = demoActiveBranch || null;

            const demoUnrestricted = ['ADMIN', 'PROPRIETOR', 'SUPER_ADMIN', 'PARENT'].includes(demoRoleUpper);
            const demoEntitled = demoUnrestricted ? null : Array.from(new Set(
                [decoded.branch_id, ...(decoded.allowed_branch_ids || [])].filter(Boolean)
            ));
            return runWithTenantContext({
                schoolId: DEMO_SCHOOL_ID,
                branchId: demoActiveBranch || null,
                userId: decoded.id,
                allowedBranchIds: demoEntitled,
            }, next);
        }

        const user = await (prisma.user.findUnique as any)({
            where: { id: decoded.id },
            include: { school: true, branch: true, teacher_profile: true, parent_profile: true }
        });

        if (!user) return res.status(401).json({ message: 'User no longer exists' });

        const headerSchoolId = req.headers['x-school-id'] as string | undefined;
        const headerBranchId = req.headers['x-branch-id'] as string | undefined;
        if (headerSchoolId && headerSchoolId !== user.school_id) {
            return res.status(403).json({ message: 'School header does not match authenticated school' });
        }

        const roleUpper = (user.role || '').toUpperCase();
        const isSchoolLevelAdmin = ['ADMIN', 'PROPRIETOR', 'SUPER_ADMIN'].includes(roleUpper)
            && (!user.branch_id || user.branch?.is_main === true);

        if (headerBranchId && user.branch_id && !isSchoolLevelAdmin) {
            const allowedBranches = [user.branch_id, ...(user.allowed_branch_ids || [])];
            const isSandboxOwner = user.school_id === DEMO_SCHOOL_ID
                && ['ADMIN', 'PROPRIETOR', 'SUPER_ADMIN'].includes(roleUpper);
            const sandboxRoot = isSandboxOwner ? String(user.branch_id).split('__')[0] : null;
            const inOwnSandbox = !!sandboxRoot &&
                (headerBranchId === sandboxRoot || headerBranchId.startsWith(sandboxRoot + '__'));
            if (!allowedBranches.includes(headerBranchId) && !inOwnSandbox) {
                return res.status(403).json({ message: 'User not authorized to access this branch' });
            }
        }

        if (headerBranchId && isSchoolLevelAdmin && user.school_id) {
            const branchOwner = await prisma.branch.findUnique({
                where: { id: headerBranchId }, select: { school_id: true }
            });
            if (branchOwner && branchOwner.school_id !== user.school_id) {
                return res.status(403).json({ message: 'User not authorized to access this branch' });
            }
        }

        const phone = user.phone || user.teacher_profile?.phone || user.parent_profile?.phone || null;
        const roleAwareGeneratedId = (() => {
            if (roleUpper === 'TEACHER' && user.teacher_profile?.school_generated_id) return user.teacher_profile.school_generated_id;
            if (roleUpper === 'PARENT' && user.parent_profile?.school_generated_id) return user.parent_profile.school_generated_id;
            return user.school_generated_id;
        })();
        const effectiveBranchId = headerBranchId || user.branch_id;

        req.user = {
            id: user.id, email: user.email, role: user.role,
            school_id: user.school_id, branch_id: user.branch_id,
            allowed_branch_ids: user.allowed_branch_ids || [],
            active_branch_id: effectiveBranchId,
            is_main_admin: isSchoolLevelAdmin,
            school_generated_id: roleAwareGeneratedId,
            full_name: user.full_name, phone, avatar_url: user.avatar_url,
            email_verified: user.email_verified, school: user.school, branch: user.branch,
            teacher_profile: user.teacher_profile, parent_profile: user.parent_profile,
            sid: decoded.sid
        };

        req.school_id = user.school_id;
        req.branch_id = effectiveBranchId;
        const branchUnrestricted = isSchoolLevelAdmin || roleUpper === 'SUPER_ADMIN' || roleUpper === 'PARENT';
        const entitledBranches = branchUnrestricted
            ? null
            : Array.from(new Set([user.branch_id, ...(user.allowed_branch_ids || [])].filter(Boolean)));

        return runWithTenantContext({
            schoolId: user.school_id,
            branchId: effectiveBranchId,
            userId: user.id,
            allowedBranchIds: entitledBranches,
        }, next);
    } catch (error: any) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Session expired' });
        }
        console.error('[Security] Authentication exception:', error);
        return res.status(401).json({ message: 'Authentication failed' });
    }
};
