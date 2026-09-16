import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
