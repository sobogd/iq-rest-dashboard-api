-- Auto-translation parity for internal support threads in the unified inbox.
ALTER TABLE "support_messages" ADD COLUMN "lang" TEXT;
ALTER TABLE "support_messages" ADD COLUMN "translatedRu" TEXT;
