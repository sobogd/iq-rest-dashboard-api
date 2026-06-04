-- Inbox: external-channel contacts (WhatsApp) and their messages.
CREATE TABLE "inbox_contacts" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "name" TEXT,
  "lang" TEXT,
  "watched" BOOLEAN NOT NULL DEFAULT false,
  "muted" BOOLEAN NOT NULL DEFAULT false,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbox_contacts_channel_externalId_key" ON "inbox_contacts"("channel", "externalId");
CREATE INDEX "inbox_contacts_lastMessageAt_idx" ON "inbox_contacts"("lastMessageAt");

CREATE TABLE "inbox_messages" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "lang" TEXT,
  "translatedRu" TEXT,
  "externalId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'received',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inbox_messages_contactId_createdAt_idx" ON "inbox_messages"("contactId", "createdAt");

ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "inbox_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
