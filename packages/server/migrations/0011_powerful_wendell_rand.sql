CREATE TABLE `sales_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`qty` integer NOT NULL,
	`entry_uom_id` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`price_source` text,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`line_subtotal_cents` integer NOT NULL,
	`qty_invoiced` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_lines_order` ON `sales_order_lines` (`tenant_id`,`order_id`);--> statement-breakpoint
CREATE TABLE `sales_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`date` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`channel` text DEFAULT 'standard' NOT NULL,
	`price_category` text NOT NULL,
	`custom_price_approved_by` text,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`vat_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`fulfillment` text DEFAULT 'delivery' NOT NULL,
	`expected_date` text,
	`pricing_version` integer,
	`vat_snapshot` text,
	`notes` text,
	`confirmed_by` text,
	`confirmed_at` text,
	`cancelled_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_number` ON `sales_orders` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `orders_customer` ON `sales_orders` (`tenant_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_date` ON `sales_orders` (`tenant_id`,`date`);--> statement-breakpoint
ALTER TABLE `sales_invoices` ADD `order_id` text;--> statement-breakpoint
CREATE INDEX `invoices_order` ON `sales_invoices` (`tenant_id`,`order_id`);