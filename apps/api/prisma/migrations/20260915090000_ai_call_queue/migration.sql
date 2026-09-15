-- AlterEnum
ALTER TYPE "AiCallStatus" ADD VALUE 'WAITING' BEFORE 'QUEUED';

-- CreateIndex
CREATE INDEX "ai_calls_status_created_at_idx" ON "ai_calls"("status", "created_at");
