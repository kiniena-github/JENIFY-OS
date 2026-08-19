CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_user` ON `recovery_codes` (`tenant_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `deliveries` ADD `branding_version` integer;--> statement-breakpoint
ALTER TABLE `goods_receipts` ADD `branding_version` integer;--> statement-breakpoint
ALTER TABLE `payments` ADD `branding_version` integer;--> statement-breakpoint
ALTER TABLE `production_batches` ADD `supervisor_name` text;--> statement-breakpoint
ALTER TABLE `sales_invoices` ADD `branding_version` integer;--> statement-breakpoint
ALTER TABLE `stock_transfers` ADD `branding_version` integer;