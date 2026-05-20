-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "NumberType" AS ENUM ('LOCAL', 'MOBILE', 'TOLL_FREE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhatsAppCompatibilityStatus" AS ENUM ('UNKNOWN', 'NOT_GUARANTEED', 'USER_TESTING', 'UNSUPPORTED', 'APPROVED_BUSINESS_SENDER');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNDELIVERED');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('INITIATED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'BUSY', 'FAILED', 'NO_ANSWER', 'CANCELED');

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('TWILIO');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twilio_accounts" (
    "id" TEXT NOT NULL,
    "account_sid" TEXT NOT NULL,
    "friendly_name" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "twilio_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "twilio_account_sid" TEXT NOT NULL,
    "twilio_incoming_phone_number_sid" TEXT NOT NULL,
    "phone_number_e164" TEXT NOT NULL,
    "country" TEXT,
    "region" TEXT,
    "locality" TEXT,
    "postal_code" TEXT,
    "area_code" TEXT,
    "number_type" "NumberType" NOT NULL DEFAULT 'UNKNOWN',
    "capabilities_voice" BOOLEAN NOT NULL DEFAULT false,
    "capabilities_sms" BOOLEAN NOT NULL DEFAULT false,
    "capabilities_mms" BOOLEAN NOT NULL DEFAULT false,
    "capabilities_whatsapp_candidate" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_compatibility_status" "WhatsAppCompatibilityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "voice_webhook_url" TEXT,
    "sms_webhook_url" TEXT,
    "status_callback_url" TEXT,
    "friendly_name" TEXT,
    "tags" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_searches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "area_code" TEXT,
    "contains" TEXT,
    "number_type" TEXT,
    "required_sms" BOOLEAN NOT NULL DEFAULT false,
    "required_voice" BOOLEAN NOT NULL DEFAULT false,
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "number_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "twilio_message_sid" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "from_e164" TEXT NOT NULL,
    "to_e164" TEXT NOT NULL,
    "body" TEXT,
    "num_media" INTEGER NOT NULL DEFAULT 0,
    "media" JSONB,
    "status" "MessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "error_code" TEXT,
    "error_message" TEXT,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "twilio_call_sid" TEXT,
    "parent_call_sid" TEXT,
    "direction" "CallDirection" NOT NULL,
    "from_e164" TEXT NOT NULL,
    "to_e164" TEXT NOT NULL,
    "browser_identity" TEXT,
    "selected_caller_id" TEXT,
    "destination_e164" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'INITIATED',
    "duration_seconds" INTEGER,
    "price" TEXT,
    "price_unit" TEXT,
    "raw_payload" JSONB,
    "started_at" TIMESTAMP(3),
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number_id" TEXT,
    "identity" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "twilio_sid" TEXT,
    "dedupe_key" TEXT,
    "raw_payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_token_hash_idx" ON "sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "twilio_accounts_account_sid_key" ON "twilio_accounts"("account_sid");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_twilio_incoming_phone_number_sid_key" ON "phone_numbers"("twilio_incoming_phone_number_sid");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_phone_number_e164_key" ON "phone_numbers"("phone_number_e164");

-- CreateIndex
CREATE INDEX "phone_numbers_phone_number_e164_idx" ON "phone_numbers"("phone_number_e164");

-- CreateIndex
CREATE INDEX "phone_numbers_twilio_incoming_phone_number_sid_idx" ON "phone_numbers"("twilio_incoming_phone_number_sid");

-- CreateIndex
CREATE INDEX "phone_numbers_user_id_idx" ON "phone_numbers"("user_id");

-- CreateIndex
CREATE INDEX "number_searches_user_id_idx" ON "number_searches"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_messages_twilio_message_sid_key" ON "sms_messages"("twilio_message_sid");

-- CreateIndex
CREATE INDEX "sms_messages_phone_number_id_created_at_idx" ON "sms_messages"("phone_number_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sms_messages_twilio_message_sid_idx" ON "sms_messages"("twilio_message_sid");

-- CreateIndex
CREATE UNIQUE INDEX "calls_twilio_call_sid_key" ON "calls"("twilio_call_sid");

-- CreateIndex
CREATE INDEX "calls_phone_number_id_created_at_idx" ON "calls"("phone_number_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "calls_twilio_call_sid_idx" ON "calls"("twilio_call_sid");

-- CreateIndex
CREATE UNIQUE INDEX "voice_identities_identity_key" ON "voice_identities"("identity");

-- CreateIndex
CREATE INDEX "voice_identities_user_id_idx" ON "voice_identities"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_dedupe_key_idx" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_twilio_account_sid_fkey" FOREIGN KEY ("twilio_account_sid") REFERENCES "twilio_accounts"("account_sid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_searches" ADD CONSTRAINT "number_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_identities" ADD CONSTRAINT "voice_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_identities" ADD CONSTRAINT "voice_identities_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
