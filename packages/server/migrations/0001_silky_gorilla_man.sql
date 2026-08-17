CREATE TABLE `simple_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`type` text NOT NULL,
	`qty` integer NOT NULL,
	`buyer` text,
	`unit_price_cents` integer,
	`date` text NOT NULL,
	`notes` text,
	`lifecycle` text DEFAULT 'posted' NOT NULL,
	`reversal_reason` text,
	`recorded_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simple_txn_number` ON `simple_transactions` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `simple_txn_item` ON `simple_transactions` (`tenant_id`,`item_id`);