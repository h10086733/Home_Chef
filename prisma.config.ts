import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'db/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://home_chef:home_chef@localhost:55432/home_chef' },
});
