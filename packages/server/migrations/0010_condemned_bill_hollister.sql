CREATE TABLE `bookable_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'resource' NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookable_resources_code` ON `bookable_resources` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`resource_id` text NOT NULL,
	`customer_id` text,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`party_size` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`notes` text,
	`cancelled_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_number` ON `bookings` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `bookings_resource_time` ON `bookings` (`tenant_id`,`resource_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `bookings_status` ON `bookings` (`tenant_id`,`status`,`start_at`);--> statement-breakpoint
CREATE TABLE `work_order_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`item_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`lot_id` text,
	`qty` integer NOT NULL,
	`issued_by` text,
	`issued_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_order_parts_wo` ON `work_order_parts` (`work_order_id`);--> statement-breakpoint
CREATE TABLE `work_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`kind` text DEFAULT 'job' NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`customer_id` text,
	`asset_ref` text,
	`assigned_to_user_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`scheduled_for` text,
	`started_at` text,
	`completed_at` text,
	`completion_note` text,
	`cancelled_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_orders_number` ON `work_orders` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `work_orders_assignee` ON `work_orders` (`tenant_id`,`assigned_to_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `work_orders_status` ON `work_orders` (`tenant_id`,`status`,`scheduled_for`);