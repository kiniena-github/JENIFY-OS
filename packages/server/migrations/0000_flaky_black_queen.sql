CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`uploaded_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachments_entity` ON `attachments` (`tenant_id`,`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`module` text NOT NULL,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`reference` text,
	`summary` text NOT NULL,
	`before` text,
	`after` text,
	`reason` text,
	`result` text DEFAULT 'success' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_tenant_time` ON `audit_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit_events` (`tenant_id`,`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`invoice_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`delivery_type` text DEFAULT 'delivery' NOT NULL,
	`destination` text,
	`truck_number` text,
	`driver_name` text,
	`driver_phone` text,
	`dispatch_date` text,
	`expected_date` text,
	`actual_date` text,
	`proof_attachment_id` text,
	`received_by` text,
	`notes` text,
	`cancelled_reason` text,
	`recorded_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_number` ON `deliveries` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `deliveries_invoice` ON `deliveries` (`tenant_id`,`invoice_id`);--> statement-breakpoint
CREATE TABLE `document_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`seq_key` text NOT NULL,
	`prefix` text NOT NULL,
	`padding` integer DEFAULT 4 NOT NULL,
	`next_value` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_sequences_key` ON `document_sequences` (`tenant_id`,`seq_key`);--> statement-breakpoint
CREATE TABLE `goods_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`date` text NOT NULL,
	`supplier_id` text NOT NULL,
	`source` text,
	`truck_number` text,
	`driver_name` text,
	`item_id` text NOT NULL,
	`gross_qty` integer,
	`net_qty` integer NOT NULL,
	`entry_uom_id` text NOT NULL,
	`entry_qty` integer NOT NULL,
	`warehouse_id` text NOT NULL,
	`received_by_user_id` text,
	`remarks` text,
	`lifecycle` text DEFAULT 'draft' NOT NULL,
	`lot_id` text,
	`approved_by` text,
	`posted_at` text,
	`reversal_of_id` text,
	`reversal_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_number` ON `goods_receipts` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`item_id` text NOT NULL,
	`lot_id` text,
	`warehouse_id` text NOT NULL,
	`qty` integer NOT NULL,
	`entry_uom_id` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`price_source` text,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`line_subtotal_cents` integer NOT NULL,
	`reservation_id` text
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice` ON `invoice_lines` (`tenant_id`,`invoice_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`tracking_mode` text DEFAULT 'none' NOT NULL,
	`base_uom_id` text NOT NULL,
	`unit_weight_milli_kg` integer,
	`sellable` integer DEFAULT false NOT NULL,
	`purchasable` integer DEFAULT false NOT NULL,
	`attributes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_code` ON `items` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `lots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`item_id` text NOT NULL,
	`lot_number` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`source_kind` text,
	`source_id` text,
	`attributes` text,
	`received_at` text,
	`initial_qty` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lots_number` ON `lots` (`tenant_id`,`lot_number`);--> statement-breakpoint
CREATE INDEX `lots_item` ON `lots` (`tenant_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`party_type` text,
	`phone` text,
	`location` text,
	`tax_info` text,
	`credit_limit_cents` integer,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `parties_kind` ON `parties` (`tenant_id`,`kind`);--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `allocations_payment` ON `payment_allocations` (`tenant_id`,`payment_id`);--> statement-breakpoint
CREATE INDEX `allocations_invoice` ON `payment_allocations` (`tenant_id`,`invoice_id`,`status`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`date` text NOT NULL,
	`customer_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`reference_number` text,
	`received_by_user_id` text,
	`notes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`posted_at` text,
	`reversal_reason` text,
	`reversal_of_id` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_number` ON `payments` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `payments_customer` ON `payments` (`tenant_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `production_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`input_lot_id` text,
	`input_batch_id` text,
	`input_warehouse_id` text,
	`input_qty` integer DEFAULT 0 NOT NULL,
	`output_qty` integer,
	`loss_qty` integer,
	`consumed_output_qty` integer DEFAULT 0 NOT NULL,
	`output_item_id` text,
	`units_produced` integer,
	`units_rejected` integer,
	`output_warehouse_id` text,
	`output_lot_id` text,
	`qc_status` text DEFAULT 'pending' NOT NULL,
	`qc_approved_by` text,
	`qc_approved_at` text,
	`operator_name` text,
	`recorded_by` text,
	`approved_by` text,
	`attributes` text,
	`notes` text,
	`completed_at` text,
	`cancelled_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_number` ON `production_batches` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `batches_stage` ON `production_batches` (`tenant_id`,`stage_id`,`status`);--> statement-breakpoint
CREATE INDEX `batches_input_batch` ON `production_batches` (`tenant_id`,`input_batch_id`);--> statement-breakpoint
CREATE INDEX `batches_input_lot` ON `production_batches` (`tenant_id`,`input_lot_id`);--> statement-breakpoint
CREATE TABLE `production_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`input_source` text NOT NULL,
	`output_form` text NOT NULL,
	`requires_qc` integer DEFAULT false NOT NULL,
	`input_item_id` text,
	`prior_stage_id` text,
	`output_item_ids` text,
	`attributes` text,
	`doc_seq_key` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stages_code` ON `production_stages` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `quality_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`target_level` text,
	`actual_result` text NOT NULL,
	`status` text NOT NULL,
	`operator_name` text,
	`tested_by` text,
	`approved_by` text,
	`approved_at` text,
	`date` text NOT NULL,
	`notes` text,
	`previous_test_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qc_attempt` ON `quality_tests` (`batch_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`item_id` text NOT NULL,
	`lot_id` text,
	`warehouse_id` text NOT NULL,
	`qty` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`document_kind` text NOT NULL,
	`document_id` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `reservations_item` ON `reservations` (`tenant_id`,`item_id`,`warehouse_id`,`status`);--> statement-breakpoint
CREATE INDEX `reservations_doc` ON `reservations` (`tenant_id`,`document_kind`,`document_id`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role_id` text NOT NULL,
	`version` integer NOT NULL,
	`matrix` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_ver` ON `role_permissions` (`role_id`,`version`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`dashboard_focus` text,
	`is_owner_role` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_code` ON `roles` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `sales_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`date` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payment_term` text NOT NULL,
	`price_category` text NOT NULL,
	`custom_price_approved_by` text,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`vat_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`due_date` text,
	`fulfillment` text DEFAULT 'delivery' NOT NULL,
	`salesperson_id` text,
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
CREATE UNIQUE INDEX `invoices_number` ON `sales_invoices` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE INDEX `invoices_customer` ON `sales_invoices` (`tenant_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `stock_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`item_id` text NOT NULL,
	`lot_id` text DEFAULT '' NOT NULL,
	`warehouse_id` text NOT NULL,
	`qty_on_hand` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balances_key` ON `stock_balances` (`tenant_id`,`item_id`,`lot_id`,`warehouse_id`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`item_id` text NOT NULL,
	`lot_id` text,
	`warehouse_id` text NOT NULL,
	`qty` integer NOT NULL,
	`movement_type` text NOT NULL,
	`document_kind` text NOT NULL,
	`document_id` text NOT NULL,
	`document_number` text,
	`counterpart_id` text,
	`note` text,
	`posted_by` text,
	`posted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `movements_item_wh` ON `stock_movements` (`tenant_id`,`item_id`,`warehouse_id`);--> statement-breakpoint
CREATE INDEX `movements_lot` ON `stock_movements` (`tenant_id`,`lot_id`);--> statement-breakpoint
CREATE INDEX `movements_doc` ON `stock_movements` (`tenant_id`,`document_kind`,`document_id`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`doc_number` text NOT NULL,
	`date` text NOT NULL,
	`item_id` text NOT NULL,
	`lot_id` text,
	`qty` integer NOT NULL,
	`entry_uom_id` text NOT NULL,
	`from_warehouse_id` text NOT NULL,
	`to_warehouse_id` text NOT NULL,
	`requested_by` text,
	`approved_by` text,
	`reason` text,
	`lifecycle` text DEFAULT 'draft' NOT NULL,
	`posted_at` text,
	`reversal_of_id` text,
	`reversal_reason` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_number` ON `stock_transfers` (`tenant_id`,`doc_number`);--> statement-breakpoint
CREATE TABLE `tenant_languages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`flag_emoji` text,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_languages_code` ON `tenant_languages` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `tenant_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_settings_ver` ON `tenant_settings` (`tenant_id`,`domain`,`version`);--> statement-breakpoint
CREATE INDEX `tenant_settings_domain` ON `tenant_settings` (`tenant_id`,`domain`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`location_note` text,
	`currency` text DEFAULT 'ETB' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`brand_color` text,
	`logo_path` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_code_unique` ON `tenants` (`code`);--> statement-breakpoint
CREATE TABLE `translation_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`en_text` text NOT NULL,
	`module` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `translation_keys_key_unique` ON `translation_keys` (`key`);--> statement-breakpoint
CREATE TABLE `translations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key_id` text NOT NULL,
	`language` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'placeholder' NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `translations_key_lang` ON `translations` (`tenant_id`,`key_id`,`language`);--> statement-breakpoint
CREATE TABLE `uoms` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`family` text NOT NULL,
	`factor_to_base_milli` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uoms_code` ON `uoms` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`phone` text,
	`password_hash` text NOT NULL,
	`role_id` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_login_at` text,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username` ON `users` (`tenant_id`,`username`);--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`location_note` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouses_code` ON `warehouses` (`tenant_id`,`code`);