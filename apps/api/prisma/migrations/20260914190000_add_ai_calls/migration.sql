-- CreateEnum
CREATE TYPE "AiCallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "AiCallStatus" AS ENUM ('QUEUED', 'RINGING', 'IN_PROGRESS', 'FORWARDING', 'ENDED', 'FAILED');

-- CreateTable
CREATE TABLE "ai_calls" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "vapi_call_id" TEXT,
    "direction" "AiCallDirection" NOT NULL DEFAULT 'OUTBOUND',
    "customer_e164" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "status" "AiCallStatus" NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT,
    "ended_reason" TEXT,
    "summary" TEXT,
    "structured_data" JSONB,
    "transcript" TEXT,
    "recording_url" TEXT,
    "school_name" TEXT,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "callback_time" TEXT,
    "consult_start_at" TIMESTAMP(3),
    "consult_event_id" TEXT,
    "consult_meet_url" TEXT,
    "cost_usd" DECIMAL(10,4),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "do_not_call_numbers" (
    "e164" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "ai_call_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "do_not_call_numbers_pkey" PRIMARY KEY ("e164")
);

-- CreateTable
CREATE TABLE "google_calendar_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "google_email" TEXT,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "refresh_token_encrypted" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_calls_vapi_call_id_key" ON "ai_calls"("vapi_call_id");

-- CreateIndex
CREATE INDEX "ai_calls_user_id_created_at_idx" ON "ai_calls"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_calls_customer_e164_created_at_idx" ON "ai_calls"("customer_e164", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_connections_user_id_key" ON "google_calendar_connections"("user_id");

-- AddForeignKey
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

