# IQ Rest Dashboard API

NestJS + Prisma backend for the IQ Rest dashboard web app.

## Setup

```bash
npm install
cp .env.example .env
# fill DATABASE_URL with the existing Postgres
npx prisma generate
npm run dev
```

Health: `GET http://localhost:4000/api/health`.

## Stack

- NestJS 10
- Prisma 5 (reads existing schema migrated from `iq-rest-web` repo)
- httpOnly cookie auth (JWT)
- Zod / class-validator for DTOs
