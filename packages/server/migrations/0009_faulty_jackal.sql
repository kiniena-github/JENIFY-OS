CREATE TABLE `credit_note_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`credit_note_id` text NOT NULL,
	`invoice_line_id` text,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`lot_id` text,
	`qty` integer NOT NULL,
	`restock` integer DEFAULT true NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credit_note_lines_note` ON `credit_note_lines` (`credit_note_id`);--> statement-breakpoint
CREATE TABLE `credit_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`invoice_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`reason` text,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`reversal_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_notes_number` ON `credit_notes` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `credit_notes_invoice` ON `credit_notes` (`tenant_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `credit_notes_customer` ON `credit_notes` (`tenant_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `purchase_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`receipt_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`date` text NOT NULL,
	`reason` text,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`lot_id` text,
	`qty` integer NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`reversal_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_returns_number` ON `purchase_returns` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `purchase_returns_receipt` ON `purchase_returns` (`tenant_id`,`receipt_id`);--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `qty_delivered` integer DEFAULT 0 NOT NULL;