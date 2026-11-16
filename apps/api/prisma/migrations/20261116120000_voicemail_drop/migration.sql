-- CreateTable
CREATE TABLE "voicemail_drops" (
    "user_id" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "content_type" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voicemail_drops_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voicemail_drops_token_key" ON "voicemail_drops"("token");

-- AddForeignKey
ALTER TABLE "voicemail_drops" ADD CONSTRAINT "voicemail_drops_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
