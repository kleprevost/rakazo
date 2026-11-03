-- Covering index for the budget check: period spend is summed without touching the table.
CREATE INDEX "usage_records_period_spend_idx" ON "usage_records" ("createdAt") INCLUDE ("userId", "botId", "costUsd");
