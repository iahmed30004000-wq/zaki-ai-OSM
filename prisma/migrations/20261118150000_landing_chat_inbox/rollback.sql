-- Rollback of 20261118150000_landing_chat_inbox.
-- Run ONLY after the previous release is redeployed: this release reads and writes both tables on every landing chat relay and in «رسائل اللاندينج».
-- What is lost: the relayed landing conversations and the staff replies written here. Zaki pages keeps its own copy of every conversation
-- (customer, assistant and the staff lines it already received). No order, customer or WhatsApp conversation is touched.
DROP TABLE IF EXISTS "landing_chat_messages";
DROP TABLE IF EXISTS "landing_chat_threads";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118150000_landing_chat_inbox';
