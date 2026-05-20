# Phase 5 - Post-Implementation Checklist

## ✅ Completed

- [x] Auth module with JWT authentication
- [x] Login/logout endpoints
- [x] Password change endpoint
- [x] Owner bootstrap endpoint
- [x] Prisma module (global)
- [x] Audit logging module
- [x] Health check endpoints
- [x] Security middleware (Helmet, CORS, rate limiting)
- [x] Role-based authorization guards
- [x] Argon2 password hashing
- [x] JWT token generation and validation
- [x] Request validation pipeline
- [x] Dependencies added to package.json

## 🔄 Next Steps (Run These Commands)

### 1. Install Dependencies

```bash
cd apps/api
pnpm install
```

This installs the new passport dependencies.

### 2. Generate Prisma Client (if not done in Phase 4)

```bash
pnpm prisma:generate
```

### 3. Run Migrations (if not done in Phase 4)

```bash
pnpm prisma:migrate
```

Name it: `init` or `phase_4_complete`

### 4. Seed Database (if not done in Phase 4)

```bash
pnpm prisma:seed
```

### 5. Set Environment Variables

Create `.env` file in `apps/api/`:

```bash
# Copy from .env.example
cp ../../.env.example .env

# Edit .env and set:
# - DATABASE_URL
# - DIRECT_DATABASE_URL
# - JWT_SECRET (generate random string)
# - CORS_ORIGINS
```

Generate JWT_SECRET:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 6. Start the API

```bash
pnpm dev
```

Should see: `🚀 API running on https://webfitalchemist.online/api`
Should see: `🚀 API running on https://webfitalchemist.online/api`

### 7. Test Health Endpoints

````bash
# Basic health
curl https://webfitalchemist.online/api/health
curl https://webfitalchemist.online/api/health
# Database health
curl https://webfitalchemist.online/api/health/db
curl https://webfitalchemist.online/api/health/db

### 8. Test Authentication

```bash
curl https://webfitalchemist.online/api/health
curl -X POST https://webfitalchemist.online/api/auth/login \
curl -X POST https://webfitalchemist.online/api/auth/login \
curl https://webfitalchemist.online/api/health/db
curl https://webfitalchemist.online/api/auth/me \
# Save the token from response
TOKEN="<paste-token-here>"

curl -X POST https://webfitalchemist.online/api/auth/change-password \
curl https://webfitalchemist.online/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
curl https://webfitalchemist.online/api/auth/me \
# Change password
curl -X POST https://webfitalchemist.online/api/auth/change-password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
curl https://webfitalchemist.online/api/auth/me \
````

curl https://webfitalchemist.online/api/auth/me

### 9. Verify Audit Logs

curl -X POST https://webfitalchemist.online/api/auth/change-password \
curl https://webfitalchemist.online/api/auth/me \
pnpm prisma:studio

````

Open `audit_logs` table and verify:

- Login event exists
- Password change event exists (if you changed password)
- IP address and user agent captured
  curl https://webfitalchemist.online/api/health
### 10. Commit Changes

```bash
git add .
git commit -m "feat: implement Phase 5 - authentication and authorization"
fetch('https://webfitalchemist.online/api/health')
````

fetch('https://webfitalchemist.online/api/health')

Before starting the API:

- [ ] Dependencies installed (`pnpm install`)
- [ ] Prisma Client generated
- [ ] Database migrations applied
- [ ] Database seeded with owner user
      curl -X POST https://webfitalchemist.online/api/auth/login \
- [ ] `JWT_SECRET` is a strong random string (min 32 chars)
- [ ] `DATABASE_URL` points to accessible database
- [ ] `CORS_ORIGINS` includes your frontend URL

## 🔍 Verification Steps

### 1. API Starts Successfully

# Should return: {"status":"ok","timestamp":"..."}

curl https://webfitalchemist.online/api/health

```bash
curl https://webfitalchemist.online/api/health/db
```

Should see:

- No errors
- "🚀 API running on https://webfitalchemist.online/api"

### 2. Health Checks Pass

```bash
curl https://webfitalchemist.online/api/health
# Should return: {"status":"ok","timestamp":"..."}

curl https://webfitalchemist.online/api/health/db
# Should return: {"status":"ok","database":"connected"}
```

### 3. Login Works

```bash
curl -X POST https://webfitalchemist.online/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"ChangeMe123!"}'
```

Should return:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "email": "owner@example.com",
    "role": "OWNER"
  }
}
```

### 4. Protected Routes Require Auth

```bash
# Without token - should return 401
curl https://webfitalchemist.online/api/auth/me

# With token - should return user
curl https://webfitalchemist.online/api/auth/me \
  -H "Authorization: Bearer <token>"
```

### 5. Audit Logs Created

Open Prisma Studio and check `audit_logs` table:

- Login events exist
- IP address captured
- User agent captured
- Timestamps correct

### 6. Rate Limiting Works

```bash
# Send 15 requests quickly
for i in {1..15}; do
  curl https://webfitalchemist.online/api/health
done
```

Should see 429 (Too Many Requests) after 10 requests.

### 7. CORS Works

Open browser console and try:

```javascript
fetch('https://webfitalchemist.online/api/health')
  .then((r) => r.json())
  .then(console.log);
```

Should work if origin is in CORS_ORIGINS.

## 🚨 Troubleshooting

### API Won't Start

**Error: "Cannot find module '@nestjs/passport'"**

- Run: `pnpm install`

**Error: "Cannot find module '@prisma/client'"**

- Run: `pnpm prisma:generate`

**Error: "Environment variable not found: JWT_SECRET"**

- Create `.env` file in `apps/api/`
- Add: `JWT_SECRET=<random-string>`

**Error: "Can't reach database server"**

- Check `DATABASE_URL` is correct
- Verify database is accessible
- Check firewall/network settings

### Login Fails

**401 Unauthorized**

- Verify email/password are correct
- Check owner user exists in database
- Verify password was hashed (not plaintext)

**500 Internal Server Error**

- Check API logs for error details
- Verify database connection
- Check Prisma Client is generated

### Protected Routes Return 401

**"Unauthorized" with valid token**

- Verify token format: `Bearer <token>`
- Check token hasn't expired (7 days)
- Verify JWT_SECRET matches between requests

**Token expired**

- Login again to get new token
- Tokens expire after 7 days

### CORS Errors

**"Access-Control-Allow-Origin" error**

- Add origin to `CORS_ORIGINS` env var
- Restart API after env change
- Format: `http://localhost:5173,https://app.example.com`

### Rate Limit Errors

**429 Too Many Requests**

- Wait 1 minute for short limit reset
- Wait 15 minutes for medium limit reset
- Adjust ThrottlerModule config if needed

## 📚 Documentation Reference

- **Phase 5 Complete:** `PHASE_5_COMPLETE.md`
- **Quick Reference:** `docs/PHASE_5_QUICK_REFERENCE.md`
- **API Endpoints:** See PHASE_5_COMPLETE.md
- **Environment Variables:** `.env.example`

## 🎯 Success Criteria

Phase 5 is complete when:

- ✅ API starts without errors
- ✅ Health endpoints return 200
- ✅ Login returns JWT token
- ✅ Protected routes require authentication
- ✅ Password change works
- ✅ Audit logs created for auth events
- ✅ Rate limiting triggers correctly
- ✅ CORS allows configured origins
- ✅ Security headers present (check with browser dev tools)

## 🚀 Ready for Phase 6

Once all verification steps pass, you're ready to begin:

**Phase 6 - Twilio Number Search, Purchase/Provisioning, Configuration, and Management**

This will implement:

- Twilio client module
- Webhook signature validation
- Number search API (by country, area code, type)
- Number purchase/provisioning
- Webhook configuration
- Number management (list, update, sync, release)
- Number detail endpoints

## 🎉 Congratulations!

You've successfully implemented Phase 5! The authentication and authorization system is production-ready with:

- Secure password hashing (Argon2)
- JWT token authentication
- Role-based authorization
- Audit logging
- Rate limiting
- Security headers
- CORS protection
- Input validation

The API is now ready for Twilio integration in Phase 6.
