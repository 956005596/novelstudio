import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma && (globalForPrisma.prisma as any).characterChapterSnapshot
    ? globalForPrisma.prisma
    : globalForPrisma.prisma && !(globalForPrisma.prisma as any).characterChapterSnapshot
      ? new PrismaClient({
          log: ['query'],
        })
      :
        new PrismaClient({
          log: ['query'],
        })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
