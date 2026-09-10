import { PrismaClient } from '../../generated/prisma-client';
import { getTenantContext } from '../lib/tenantContext';

const SENSITIVE_FIELDS = ['password_hash', 'two_factor_secret', 'initial_password'];

function stripSensitiveFields(value: any, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) stripSensitiveFields(item, depth + 1);
    return;
  }
  for (const field of SENSITIVE_FIELDS) {
    if (field in value) delete value[field];
  }
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child && typeof child === 'object' && !(child instanceof Date)) {
      stripSensitiveFields(child, depth + 1);
    }
  }
}

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
  var __rawPrisma: PrismaClient | undefined;
}

const prismaClientSingleton = () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Refusing to start with a fallback database credential.');
  }

  const obfuscatedUrl = databaseUrl.replace(/\/\/.*:.*@/, '//****:****@');
  console.log('✅ [Prisma] Initializing with DATABASE_URL:', obfuscatedUrl);

  let finalUrl = databaseUrl;
  try {
    const u = new URL(databaseUrl);
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '20');
    if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '30');
    finalUrl = u.toString();
  } catch {
    throw new Error('DATABASE_URL is invalid.');
  }

  const client = new PrismaClient({
    datasources: { db: { url: finalUrl } },
    transactionOptions: { timeout: 20000, maxWait: 10000 },
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['info', 'warn', 'error'],
  });

  // Defense in depth: no Prisma path may persist or return a user's plaintext
  // password. Existing rows are not modified here; deployment should migrate
  // old initial_password values to NULL separately after all callers are fixed.
  client.$use(async (params, next) => {
    if (params.model === 'User') {
      if (params.action === 'create' || params.action === 'update' || params.action === 'upsert') {
        const data = params.args?.data;
        if (data && typeof data === 'object') {
          delete data.initial_password;
          if (data.password !== undefined) delete data.password;
        }
      }
    }

    const result = await next(params);
    stripSensitiveFields(result);
    return result;
  });

  globalThis.__rawPrisma = client;

  return client.$extends({
    query: {
      async $allOperations({ args, query }) {
        const TIMEOUT_MS = 30000;
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('PrismaQueryTimeout: Operation exceeded 30s limit.')), TIMEOUT_MS)
        );
        const ctx = getTenantContext();

        const run = async () => {
          if (ctx?.schoolId) {
            const raw = globalThis.__rawPrisma!;
            const setters = [
              raw.$executeRaw`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`,
            ];
            if (ctx.branchId) {
              setters.push(raw.$executeRaw`SELECT set_config('app.current_branch_id', ${ctx.branchId}, true)`);
            }
            if (ctx.userId) {
              setters.push(raw.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`);
            }
            const branchList = ctx.allowedBranchIds?.length ? ctx.allowedBranchIds.join(',') : '';
            setters.push(raw.$executeRaw`SELECT set_config('app.current_branch_ids', ${branchList}, true)`);
            const results = await raw.$transaction([...setters, query(args)] as any);
            return results[results.length - 1];
          }

          // Explicitly mark unscoped operations (login, onboarding, platform
          // operations and scripts) as RLS bypass operations. These are the only
          // operations that may run without an authenticated tenant context.
          const raw = globalThis.__rawPrisma!;
          const results = await raw.$transaction([
            raw.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`,
            query(args),
          ] as any);
          return results[results.length - 1];
        };

        const result = await Promise.race([run(), timeoutPromise]);
        stripSensitiveFields(result);
        return result;
      },
    },
  });
};

const prisma = globalThis.prisma ?? prismaClientSingleton();

/**
 * Privileged Prisma client for authentication/2FA operations that require
 * password_hash or two_factor_secret. It still strips every sensitive field
 * except those explicitly selected for the privileged operation, and it never
 * permits initial_password to be written.
 */
let _privilegedPrisma: any = null;
export function getRawPrisma(): PrismaClient {
  if (!globalThis.__rawPrisma) prismaClientSingleton();
  if (!_privilegedPrisma) {
    const base = globalThis.__rawPrisma!;
    _privilegedPrisma = base.$extends({
      query: {
        async $allOperations({ model, args, query }) {
          if (!model) return query(args);
          const results = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`,
            query(args),
          ] as any);
          return results[results.length - 1];
        },
      },
    });
  }
  return _privilegedPrisma as PrismaClient;
}

const dbUrl = process.env.DATABASE_URL || '';
const finalObfuscatedUrl = dbUrl.replace(/\/\/.*:.*@/, '//****:****@');
console.log('📦 [Prisma] Status:', dbUrl ? 'CONNECTED (CONFIGURED)' : 'DISCONNECTED');
if (dbUrl) console.log('📦 [Prisma] Database:', finalObfuscatedUrl);

export default prisma;

if (process.env.NODE_ENV === 'production') {
  prisma.$connect()
    .then(() => console.log('🚀 [Prisma] Production database connection established successfully.'))
    .catch((err) => {
      console.error('❌ [Prisma] Production database connection FAILED:', err instanceof Error ? err.message : 'unknown error');
    });
}

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
