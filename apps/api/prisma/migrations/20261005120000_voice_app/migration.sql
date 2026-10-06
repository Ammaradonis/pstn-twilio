-- AlterTable
ALTER TABLE "users" ADD COLUMN     "experience" TEXT NOT NULL DEFAULT 'console';

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "handled_by" TEXT;

-- AlterTable
ALTER TABLE "call_recordings" ADD COLUMN     "heard_at" TIMESTAMP(3),
ADD COLUMN     "transcript" TEXT,
ADD COLUMN     "transcript_status" TEXT;

-- CreateTable
CREATE TABLE "voice_settings" (
    "user_id" TEXT NOT NULL,
    "history_starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ring_devices" BOOLEAN NOT NULL DEFAULT true,
    "screen_calls" BOOLEAN NOT NULL DEFAULT true,
    "ring_seconds" INTEGER NOT NULL DEFAULT 25,
    "do_not_disturb" BOOLEAN NOT NULL DEFAULT false,
    "do_not_disturb_until" TIMESTAMP(3),
    "voicemail_enabled" BOOLEAN NOT NULL DEFAULT true,
    "voicemail_transcribe" BOOLEAN NOT NULL DEFAULT true,
    "greeting_mode" TEXT NOT NULL DEFAULT 'default',
    "greeting_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "voicemail_greetings" (
    "user_id" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "content_type" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voicemail_greetings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_phones" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "contact_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_numbers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forwarding_numbers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMP(3),
    "verify_code_hash" TEXT,
    "verify_expires_at" TIMESTAMP(3),
    "verify_call_sid" TEXT,
    "verify_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forwarding_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "push_endpoint" TEXT,
    "push_p256dh" TEXT,
    "push_auth" TEXT,
    "push_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "read_markers" (
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "read_markers_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "voicemail_greetings_token_key" ON "voicemail_greetings"("token");

-- CreateIndex
CREATE INDEX "contacts_user_id_name_idx" ON "contacts"("user_id", "name");

-- CreateIndex
CREATE INDEX "contact_phones_user_id_e164_idx" ON "contact_phones"("user_id", "e164");

-- CreateIndex
CREATE UNIQUE INDEX "contact_phones_contact_id_e164_key" ON "contact_phones"("contact_id", "e164");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_numbers_user_id_e164_key" ON "blocked_numbers"("user_id", "e164");

-- CreateIndex
CREATE UNIQUE INDEX "forwarding_numbers_user_id_e164_key" ON "forwarding_numbers"("user_id", "e164");

-- CreateIndex
CREATE UNIQUE INDEX "user_devices_push_endpoint_key" ON "user_devices"("push_endpoint");

-- CreateIndex
CREATE INDEX "user_devices_user_id_idx" ON "user_devices"("user_id");

-- AddForeignKey
ALTER TABLE "voice_settings" ADD CONSTRAINT "voice_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voicemail_greetings" ADD CONSTRAINT "voicemail_greetings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_numbers" ADD CONSTRAINT "blocked_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forwarding_numbers" ADD CONSTRAINT "forwarding_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "read_markers" ADD CONSTRAINT "read_markers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

