-- Admin-assigned internal name + free-form note per inbox contact.
ALTER TABLE "inbox_contacts" ADD COLUMN "customName" TEXT;
ALTER TABLE "inbox_contacts" ADD COLUMN "note" TEXT;
