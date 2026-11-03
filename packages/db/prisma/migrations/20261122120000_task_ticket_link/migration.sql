-- Links the task a ticket wake creates to its ticket, so runs and artifacts can be listed per ticket.
ALTER TABLE "tasks" ADD COLUMN "ticketId" TEXT;
CREATE INDEX "tasks_ticketId_idx" ON "tasks"("ticketId");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
