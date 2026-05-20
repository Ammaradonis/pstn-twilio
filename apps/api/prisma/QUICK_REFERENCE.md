# Database Schema Quick Reference

## Entity Relationship Overview

```
User (1) ──< (N) Session
User (1) ──< (N) PhoneNumber
User (1) ──< (N) NumberSearch
User (1) ──< (N) VoiceIdentity
User (1) ──< (N) AuditLog

TwilioAccount (1) ──< (N) PhoneNumber

PhoneNumber (1) ──< (N) SmsMessage
PhoneNumber (1) ──< (N) Call
PhoneNumber (1) ──< (N) VoiceIdentity

User (1) ──< (N) AppSetting (updatedBy)
```

## Table Summary

| Table              | Purpose             | Key Fields                      |
| ------------------ | ------------------- | ------------------------------- |
| `users`            | User accounts       | email, passwordHash, role       |
| `sessions`         | Auth sessions       | tokenHash, expiresAt            |
| `twilio_accounts`  | Twilio credentials  | accountSid, isDefault           |
| `phone_numbers`    | Provisioned numbers | phoneNumberE164, capabilities   |
| `number_searches`  | Search audit        | country, areaCode, resultCount  |
| `sms_messages`     | SMS inbox/outbox    | direction, body, status         |
| `calls`            | Call logs           | direction, status, duration     |
| `voice_identities` | Device identities   | identity, label                 |
| `audit_logs`       | Action audit trail  | action, entityType, metadata    |
| `webhook_events`   | Webhook storage     | provider, eventType, rawPayload |
| `app_settings`     | App configuration   | key, value                      |

## Common Queries

### Find User by Email

```typescript
const user = await prisma.user.findUnique({
  where: { email: 'owner@example.com' },
});
```

### Get Active Phone Numbers for User

```typescript
const numbers = await prisma.phoneNumber.findMany({
  where: {
    userId: userId,
    active: true,
    releasedAt: null,
  },
  orderBy: { purchasedAt: 'desc' },
});
```

### Get Recent SMS for a Number

```typescript
const messages = await prisma.smsMessage.findMany({
  where: { phoneNumberId: numberId },
  orderBy: { createdAt: 'desc' },
  take: 50,
});
```

### Get Call History for a Number

```typescript
const calls = await prisma.call.findMany({
  where: { phoneNumberId: numberId },
  orderBy: { createdAt: 'desc' },
  take: 50,
});
```

### Create Audit Log Entry

```typescript
await prisma.auditLog.create({
  data: {
    userId: userId,
    action: 'number.purchased',
    entityType: 'PhoneNumber',
    entityId: numberId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    metadata: { phoneNumber: '+1234567890' },
  },
});
```

### Deduplicate Webhook

```typescript
const existing = await prisma.webhookEvent.findUnique({
  where: { dedupeKey: messageSid },
});

if (!existing) {
  await prisma.webhookEvent.create({
    data: {
      provider: 'TWILIO',
      eventType: 'message.received',
      signatureValid: true,
      twilioSid: messageSid,
      dedupeKey: messageSid,
      rawPayload: webhookBody,
    },
  });
}
```

## Enum Values

### UserRole

- `OWNER` - Full system access
- `ADMIN` - Administrative access
- `OPERATOR` - Operational access
- `VIEWER` - Read-only access

### NumberType

- `LOCAL` - Local landline number
- `MOBILE` - Mobile number
- `TOLL_FREE` - Toll-free number
- `UNKNOWN` - Type not determined

### WhatsAppCompatibilityStatus

- `UNKNOWN` - Not tested
- `NOT_GUARANTEED` - Default, no guarantee
- `USER_TESTING` - User is testing
- `UNSUPPORTED` - Confirmed not supported
- `APPROVED_BUSINESS_SENDER` - Officially approved

### MessageStatus

- `RECEIVED` - Inbound message received
- `QUEUED` - Outbound message queued
- `SENT` - Outbound message sent
- `DELIVERED` - Outbound message delivered
- `FAILED` - Message failed
- `UNDELIVERED` - Message undelivered

### CallStatus

- `INITIATED` - Call initiated
- `RINGING` - Call ringing
- `IN_PROGRESS` - Call in progress
- `COMPLETED` - Call completed
- `BUSY` - Recipient busy
- `FAILED` - Call failed
- `NO_ANSWER` - No answer
- `CANCELED` - Call canceled

## Migration Commands

```bash
# Generate Prisma Client
pnpm prisma:generate

# Create migration (development)
pnpm prisma:migrate

# Apply migrations (production)
pnpm prisma:migrate:deploy

# Format schema
pnpm prisma:format

# Open Prisma Studio
pnpm prisma:studio

# Seed database
pnpm prisma:seed

# Reset database (WARNING: deletes all data)
pnpm prisma migrate reset
```

## Seed Script Environment Variables

```bash
# Owner user credentials
OWNER_EMAIL=owner@example.com
OWNER_INITIAL_PASSWORD=SecurePassword123!

# Optional: Create default Twilio account
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Index Strategy

### High-Traffic Queries

- User lookups by email (unique index)
- Session validation by tokenHash
- Phone number lookups by E.164 and Twilio SID
- Message/call history by phoneNumberId + createdAt DESC

### Deduplication

- Webhook events by dedupeKey (unique)
- Twilio resource SIDs (unique)

### Audit & Compliance

- Audit logs by createdAt DESC (time-series)
- Audit logs by userId (user activity)

## Best Practices

1. **Always use transactions** for multi-step operations
2. **Hash sensitive data** before storage (passwords, tokens)
3. **Validate Twilio signatures** before processing webhooks
4. **Create audit logs** for all sensitive mutations
5. **Use dedupeKey** to prevent duplicate webhook processing
6. **Store raw payloads** for debugging (but never secrets)
7. **Soft delete** when possible (disabledAt, releasedAt)
8. **Use E.164 format** for all phone numbers
9. **Index foreign keys** for join performance
10. **Use JSON fields** for flexible metadata

## Security Checklist

- ✅ Passwords hashed with Argon2id
- ✅ Session tokens hashed before storage
- ✅ Audit logs for sensitive actions
- ✅ Soft delete support for users
- ✅ Foreign key constraints with appropriate cascades
- ✅ Unique constraints on critical fields
- ✅ No secrets stored in raw payloads
- ✅ IP address and user agent tracking
- ✅ Session expiration and revocation
- ✅ Role-based access control ready
