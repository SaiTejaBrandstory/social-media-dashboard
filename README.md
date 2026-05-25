# BrandStory · Social Strategy Command Center

Next.js app with **Google Sign-In**, **Neon PostgreSQL**, and funnel-mapped content calendars.

## Quick start

### 1. Neon database

1. Create a project at [neon.tech](https://neon.tech)
2. Copy the **connection string** (pooled or direct)

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth Web Client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client secret |
| `OPENROUTER_API_KEY` | For AI calendar/brief/trends |

### 3. Google Cloud Console

- OAuth **Web application**
- **Authorized redirect URI**: `http://localhost:3000/api/auth/callback/google` (use your dev port if different, e.g. `3002`)
- **Authorized JavaScript origins**: `http://localhost:3000` (and your production URL)

### 4. Install & migrate

```bash
npm install
npm run db:push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → **/login** → **Continue with Google** → **/** (main app).

## How it works

- **Protected app**: `middleware.ts` redirects unauthenticated users to `/login`
- **Data**: Brands, calendars, briefs, trends stored in **Neon** per `userId`
- **API**: `/api/brands`, `/api/calendars`, etc. (session cookie required)
- **Export**: CSV, Excel, PDF, and Markdown from the Download menu

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local development |
| `npm run db:push` | Push Prisma schema to Neon |
| `npm run db:studio` | Browse DB in Prisma Studio |
| `npm run build` | Production build |

## Deploy (Vercel)

Add the same env vars in Vercel project settings. Set production redirect URI in Google Console to  
`https://your-domain.vercel.app/api/auth/callback/google`.

## Project structure

```
app/
  login/page.tsx       # Google sign-in (public) — /login
  page.tsx             # Main app (protected) — /
  api/auth/            # Auth.js
  api/brands/          # CRUD
  api/briefs/
  api/calendars/
auth.ts                # NextAuth config
middleware.ts          # Route protection
prisma/schema.prisma   # Neon schema
public/sc-app.js       # Main app UI (single-page, mounted at /)
```
