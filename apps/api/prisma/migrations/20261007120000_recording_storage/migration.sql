-- AlterTable
ALTER TABLE "call_recordings" ADD COLUMN     "archive_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "archive_error" TEXT,
ADD COLUMN     "content_type" TEXT,
ADD COLUMN     "size_bytes" INTEGER,
ADD COLUMN     "storage_key" TEXT,
ADD COLUMN     "stored_at" TIMESTAMP(3),
ADD COLUMN     "twilio_deleted_at" TIMESTAMP(3),
ALTER COLUMN "twilio_recording_sid" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "call_recordings_status_stored_at_idx" ON "call_recordings"("status", "stored_at");

