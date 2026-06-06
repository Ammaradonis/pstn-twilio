-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABSENT');

-- CreateTable
CREATE TABLE "call_recordings" (
    "id" TEXT NOT NULL,
    "call_id" TEXT,
    "twilio_call_sid" TEXT NOT NULL,
    "twilio_recording_sid" TEXT NOT NULL,
    "recording_url" TEXT,
    "status" "RecordingStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "duration_seconds" INTEGER,
    "channels" INTEGER,
    "source" TEXT,
    "track" TEXT,
    "raw_payload" JSONB,
    "started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_recordings_twilio_recording_sid_key" ON "call_recordings"("twilio_recording_sid");

-- CreateIndex
CREATE INDEX "call_recordings_call_id_idx" ON "call_recordings"("call_id");

-- CreateIndex
CREATE INDEX "call_recordings_twilio_call_sid_idx" ON "call_recordings"("twilio_call_sid");

-- CreateIndex
CREATE INDEX "call_recordings_twilio_recording_sid_idx" ON "call_recordings"("twilio_recording_sid");

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
