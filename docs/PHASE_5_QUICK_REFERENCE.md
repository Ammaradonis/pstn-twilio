# Phase 5 - Quick Reference

## Authentication Flow

```
1. User sends email + password to POST /api/auth/login
2. Server verifies credentials (Argon2)
3. Server generates JWT token (7-day expiry)
4. Server logs auth.login to audit_logs
5. Server returns { token, user }
6. Client stores token
7. Client sends token in Authorization header for protected routes
```

## Protecting Routes

```typescript
// Require authentication
@UseGuards(JwtAuthGuard)

// Require specific role
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)

// Access current user
@Req() req: any
const userId = req.user.id;
const userEmail = req.user.email;
const userRole = req.user.role;
```

## API Endpoints

| Method | Endpoint                  | Auth | Description                             |
| ------ | ------------------------- | ---- | --------------------------------------- |
| POST   | /api/auth/login           | No   | Login with email/password               |
| POST   | /api/auth/logout          | Yes  | Logout (informational)                  |
| GET    | /api/auth/me              | Yes  | Get current user                        |
| POST   | /api/auth/change-password | Yes  | Change password                         |
| POST   | /api/auth/bootstrap-owner | No   | Create owner (requires BOOTSTRAP_TOKEN) |
| GET    | /api/health               | No   | Health check                            |
| GET    | /api/health/db            | No   | Database health                         |

## Request Examples

### Login

```bash
curl -X POST https://webfitalchemist.online/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"ChangeMe123!"}'
```

### Get Current User

```bash
curl https://webfitalchemist.online/api/auth/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Change Password

```bash
curl -X POST https://webfitalchemist.online/api/auth/change-password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"oldPassword":"old","newPassword":"new"}'
```

## Environment Variables

```bash
# Required
JWT_SECRET=your-secret-key-min-32-chars
CORS_ORIGINS=http://localhost:5173,https://app.example.com

# Optional
BOOTSTRAP_TOKEN=secret-bootstrap-token
PORT=3000
```

## Audit Logging

```typescript
await this.audit.log({
  userId: 'uuid',
  action: 'resource.action',
  entityType: 'EntityName',
  entityId: 'uuid',
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
  metadata: { key: 'value' },
});
```

## Common Actions

| Action                  | Description                 |
| ----------------------- | --------------------------- |
| auth.login              | User logged in              |
| auth.logout             | User logged out             |
| auth.password_changed   | Password changed            |
| auth.owner_bootstrapped | Owner created via bootstrap |

## Rate Limits

- **Short:** 10 requests per minute
- **Medium:** 100 requests per 15 minutes

## Security Headers (Helmet)

- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- X-XSS-Protection: 1; mode=block
- Strict-Transport-Security: max-age=15552000

## JWT Token Structure

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "OWNER",
  "iat": 1234567890,
  "exp": 1234567890
}
```

## Error Responses

### 401 Unauthorized

```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

### 403 Forbidden

```json
{
  "statusCode": 403,
  "message": "Forbidden resource"
}
```

### 429 Too Many Requests

```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests"
}
```

## Testing Checklist

- [ ] Login with valid credentials returns token
- [ ] Login with invalid credentials returns 401
- [ ] Protected routes without token return 401
- [ ] Protected routes with valid token return data
- [ ] Protected routes with expired token return 401
- [ ] Role-protected routes enforce roles
- [ ] Password change with wrong old password fails
- [ ] Password change with correct old password succeeds
- [ ] Audit logs created for auth events
- [ ] Rate limiting triggers after threshold
- [ ] CORS blocks unauthorized origins
- [ ] Health endpoints return 200

## Common Issues

### "Unauthorized" on protected routes

- Check token is in Authorization header
- Verify token format: `Bearer <token>`
- Check token hasn't expired (7 days)
- Verify JWT_SECRET matches

### CORS errors

- Add origin to CORS_ORIGINS env var
- Restart API after env change
- Check browser console for exact error

### Rate limit errors

- Wait for rate limit window to reset
- Adjust ThrottlerModule config if needed
- Check if multiple requests sent simultaneously

## Next Steps

After Phase 5:

1. Install dependencies: `pnpm install`
2. Generate Prisma Client: `pnpm prisma:generate`
3. Run migrations: `pnpm prisma:migrate`
4. Seed database: `pnpm prisma:seed`
5. Start API: `pnpm dev`
6. Test login with seeded owner
7. Proceed to Phase 6 (Twilio Integration)
