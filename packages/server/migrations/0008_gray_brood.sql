CREATE TABLE `approval_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`step` integer NOT NULL,
	`action` text NOT NULL,
	`actor_user_id` text,
	`comment` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approval_actions_request` ON `approval_actions` (`request_id`);--> statement-breakpoint
CREATE TABLE `approval_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`version` integer NOT NULL,
	`policy` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_policies_ver` ON `approval_policies` (`tenant_id`,`subject_type`,`version`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`magnitude_minor` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_step` integer DEFAULT 0 NOT NULL,
	`total_steps` integer DEFAULT 1 NOT NULL,
	`policy_version` integer,
	`requested_by` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `approval_requests_subject` ON `approval_requests` (`tenant_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `approval_requests_status` ON `approval_requests` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `role_experiences` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role_id` text NOT NULL,
	`version` integer NOT NULL,
	`spec` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_experiences_ver` ON `role_experiences` (`role_id`,`version`);--> statement-breakpoint
CREATE TABLE `sync_ops` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`op_key` text NOT NULL,
	`op_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`result_ref` text,
	`message` text,
	`device_id` text,
	`applied_by` text,
	`client_created_at` text,
	`server_applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_ops_key` ON `sync_ops` (`tenant_id`,`op_key`);