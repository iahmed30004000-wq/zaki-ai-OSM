-- Rollback for 20261030170000_costs_insights_keys.
-- Run ONLY after the code that asks for the new keys is reverted: with the code in place, removing these rows hides the cost
-- and the margin of a product, a batch, the stock and an order from everybody, hides every smart card (the product grades
-- and figures, the dashboard's rankings and loss reasons, the channel scores, the return risk of an order and of a customer,
-- the campaign cards, the page verdicts, the search box's live counts), and closes the confirmation team's two tables to
-- everybody who read them through users.view or a role name (the screens themselves keep working; only those figures go).
-- Removes only the rows that migration wrote (ids starting with 'ci10-'), in all three places a grant lives. Those people go
-- back to exactly the keys they held before.
-- A row the owner saved again since then has a new id and is his — it stays.
DELETE FROM "user_permissions"         WHERE "id" LIKE 'ci10-%';
DELETE FROM "role_permission_defaults" WHERE "id" LIKE 'ci10-%';
DELETE FROM "role_permissions"         WHERE "id" LIKE 'ci10-%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030170000_costs_insights_keys';
