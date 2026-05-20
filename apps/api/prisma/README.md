# Database Schema - Phase 4

This document describes the database schema for the PSTN-Twilio application.

## Overview

The schema is designed for a single-owner application but is extensible to multi-user scenarios. It uses PostgreSQL via Neon.tech with Prisma ORM.

## Core Models

### User

Stores user accounts with role-based access control.

**Fields:**

- `id` (UUID): Primary key
- `email` (String, unique): User email address
- `passwordHash` (String, nullable): Argon2 hashed password
- `role` (UserRole enum): OWNER, ADMIN, OPERATOR, VIEWER
- `createdAt`, `updatedAt`, `lastLoginAt`, `disabledAt`: Timestamps

**Relations:**

- One-to-many: Sessions, PhoneNumbers, NumberSearches, VoiceIdentities, AuditLogs

### Session

Manages user authentication sessions.

**Fields:**

- `id` (UUID): Primary key
- `userId` (UUID): Foreign key to User
- `tokenHash` (String): Hashed session token
- `userAgent`, `ipAddress`: Client information
- `expiresAt`, `revokedAt`: Session lifecycle
- `createdAt`: Timestamp

**Indexes:**

- `userId`, `tokenHash`

### TwilioAccount

Stores Twilio account credentials and configuration.

**Fields:**

- `id` (UUID): Primary key
- `accountSid` (String, unique): Twilio Account SID
- `friendlyName` (String, nullable): Display name
- `isDefault` (Boolean): Default account flag
- `createdAt`, `updatedAt`: Timestamps

### PhoneNumber

Represents provisioned Twilio phone numbers.

**Fields:**

- `id` (UUID): Primary key
- `userId` (UUID, nullable): Owner
- `twilioAccountSid` (String): Foreign key to TwilioAccount
- `twilioIncomingPhoneNumberSid` (String, unique): Twilio resource SID
- `phoneNumberE164` (String, unique): E.164 formatted number
- `country`, `region`, `locality`, `postalCode`, `areaCode`: Geographic data
- `numberType` (NumberType enum): LOCAL, MOBILE, TOLL_FREE, UNKNOWN
- `capabilitiesVoice`, `capabilitiesSms`, `capabilitiesMms`: Boolean capabilities
- `capabilitiesWhatsappCandidate` (Boolean): Potential WhatsApp compatibility
- `whatsappCompatibilityStatus` (WhatsAppCompatibilityStatus enum): Compatibility status
- `voiceWebhookUrl`, `smsWebhookUrl`, `statusCallbackUrl`: Webhook URLs
- `friendlyName` (String, nullable): Display name
- `tags` (JSON, nullable): Custom metadata
- `active` (Boolean): Active status
- `purchasedAt`, `releasedAt`: Lifecycle timestamps
- `createdAt`, `updatedAt`: Timestamps

**Indexes:**

- `phoneNumberE164`, `twilioIncomingPhoneNumberSid`, `userId`

**Relations:**

- Many-to-one: User, TwilioAccount
- One-to-many: SmsMessages, Calls, VoiceIdentities

### NumberSearch

Audit log for phone number searches.

**Fields:**

- `id` (UUID): Primary key
- `userId` (UUID): Foreign key to User
- `country`, `areaCode`, `contains`, `numberType`: Search criteria
- `requiredSms`, `requiredVoice` (Boolean): Required capabilities
- `resultCount` (Int): Number of results returned
- `createdAt`: Timestamp

**Indexes:**

- `userId`

### SmsMessage

Stores inbound and outbound SMS messages.

**Fields:**

- `id` (UUID): Primary key
- `phoneNumberId` (UUID): Foreign key to PhoneNumber
- `twilioMessageSid` (String, unique, nullable): Twilio Message SID
- `direction` (MessageDirection enum): INBOUND, OUTBOUND
- `fromE164`, `toE164` (String): Sender and recipient
- `body` (String, nullable): Message content
- `numMedia` (Int): Number of media attachments
- `media` (JSON, nullable): Media metadata
- `status` (MessageStatus enum): RECEIVED, QUEUED, SENT, DELIVERED, FAILED, UNDELIVERED
- `errorCode`, `errorMessage` (String, nullable): Error details
- `rawPayload` (JSON, nullable): Full Twilio webhook payload
- `createdAt`, `updatedAt`: Timestamps

**Indexes:**

- `phoneNumberId` + `createdAt DESC`, `twilioMessageSid`

### Call

Stores inbound and outbound voice calls.

**Fields:**

- `id` (UUID): Primary key
- `phoneNumberId` (UUID, nullable): Foreign key to PhoneNumber
- `twilioCallSid` (String, unique, nullable): Twilio Call SID
- `parentCallSid` (String, nullable): Parent call for forwarding
- `direction` (CallDirection enum): INBOUND, OUTBOUND
- `fromE164`, `toE164` (String): Caller and recipient
- `browserIdentity` (String, nullable): Twilio Device identity
- `selectedCallerId` (String, nullable): Selected caller ID for outbound
- `destinationE164` (String, nullable): Destination for outbound
- `status` (CallStatus enum): INITIATED, RINGING, IN_PROGRESS, COMPLETED, BUSY, FAILED, NO_ANSWER, CANCELED
- `durationSeconds` (Int, nullable): Call duration
- `price`, `priceUnit` (String, nullable): Cost information
- `rawPayload` (JSON, nullable): Full Twilio webhook payload
- `startedAt`, `answeredAt`, `endedAt`: Call lifecycle timestamps
- `createdAt`, `updatedAt`: Timestamps

**Indexes:**

- `phoneNumberId` + `createdAt DESC`, `twilioCallSid`

### VoiceIdentity

Maps Twilio Device identities to users and phone numbers.

**Fields:**

- `id` (UUID): Primary key
- `userId` (UUID): Foreign key to User
- `phoneNumberId` (UUID, nullable): Foreign key to PhoneNumber
- `identity` (String, unique): Twilio Device identity
- `label` (String, nullable): Display name
- `createdAt`, `updatedAt`: Timestamps

**Indexes:**

- `userId`

### AuditLog

Records sensitive actions for compliance and debugging.

**Fields:**

- `id` (UUID): Primary key
- `userId` (UUID, nullable): Foreign key to User
- `action` (String): Action performed
- `entityType`, `entityId` (String): Affected entity
- `ipAddress`, `userAgent` (String, nullable): Client information
- `metadata` (JSON, nullable): Additional context
- `createdAt`: Timestamp

**Indexes:**

- `createdAt DESC`, `userId`

### WebhookEvent

Stores all incoming webhook events for debugging and deduplication.

**Fields:**

- `id` (UUID): Primary key
- `provider` (WebhookProvider enum): TWILIO
- `eventType` (String): Event type
- `signatureValid` (Boolean): Signature validation result
- `twilioSid` (String, nullable): Associated Twilio resource SID
- `dedupeKey` (String, unique, nullable): Deduplication key
- `rawPayload` (JSON): Full webhook payload
- `processedAt` (DateTime, nullable): Processing timestamp
- `createdAt`: Timestamp

**Indexes:**

- `dedupeKey`, `createdAt DESC`

### AppSetting

Stores application-wide configuration.

**Fields:**

- `key` (String): Primary key
- `value` (JSON): Setting value
- `updatedBy` (UUID): Foreign key to User
- `updatedAt`: Timestamp

## Enums

- **UserRole**: OWNER, ADMIN, OPERATOR, VIEWER
- **NumberType**: LOCAL, MOBILE, TOLL_FREE, UNKNOWN
- **WhatsAppCompatibilityStatus**: UNKNOWN, NOT_GUARANTEED, USER_TESTING, UNSUPPORTED, APPROVED_BUSINESS_SENDER
- **MessageDirection**: INBOUND, OUTBOUND
- **MessageStatus**: RECEIVED, QUEUED, SENT, DELIVERED, FAILED, UNDELIVERED
- **CallDirection**: INBOUND, OUTBOUND
- **CallStatus**: INITIATED, RINGING, IN_PROGRESS, COMPLETED, BUSY, FAILED, NO_ANSWER, CANCELED
- **WebhookProvider**: TWILIO

## Database Constraints

- **Unique constraints**: Prevent duplicate phone numbers, Twilio SIDs, and email addresses
- **Foreign key constraints**: Maintain referential integrity with CASCADE and SET NULL policies
- **Indexes**: Optimize queries for common access patterns (user lookups, message/call history, webhook deduplication)

## Migration Commands

```bash
# Generate Prisma Client
pnpm prisma:generate

# Create a new migration
pnpm prisma:migrate

# Apply migrations in production
pnpm prisma:migrate:deploy

# Format schema
pnpm prisma:format

# Open Prisma Studio
pnpm prisma:studio

# Seed database
pnpm prisma:seed
```

## Seed Script

The seed script (`prisma/seed.ts`) creates:

1. An owner user with credentials from environment variables
2. A default Twilio account if `TWILIO_ACCOUNT_SID` is set

**Environment variables:**

- `OWNER_EMAIL` (default: owner@example.com)
- `OWNER_INITIAL_PASSWORD` (default: ChangeMe123!)
- `TWILIO_ACCOUNT_SID` (optional)

## Security Considerations

1. **Password Storage**: Uses Argon2id for password hashing
2. **Raw Payloads**: Stored for debugging but secrets should never be included
3. **Audit Logging**: All sensitive mutations are logged
4. **Soft Deletes**: Users can be disabled without data loss
5. **Session Management**: Tokens are hashed and can be revoked

## WhatsApp Compatibility

The schema includes fields for tracking WhatsApp compatibility, but the application:

- Does NOT guarantee WhatsApp compatibility
- Clearly labels numbers as "not guaranteed"
- Allows manual testing and status updates
- Follows Twilio/Meta policies

## Next Steps (Phase 5+)

After implementing this schema:

1. Generate the initial migration
2. Run the seed script to create the owner user
3. Implement authentication and authorization (Phase 5)
4. Build the Twilio integration services (Phase 6+)
