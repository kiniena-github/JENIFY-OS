CREATE TABLE `sso_hq_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_hash` text NOT NULL,
	`audience` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text NOT NULL,
	`realm_id` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`session_established_at` text NOT NULL,
	`origin_session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_hq_tickets_ticket_hash_unique` ON `sso_hq_tickets` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `sso_hq_tickets_origin` ON `sso_hq_tickets` (`origin_session_id`);