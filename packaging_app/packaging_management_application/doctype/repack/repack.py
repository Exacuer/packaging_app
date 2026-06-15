# Copyright (c) 2026, Vivek Choudhary and contributors
# For license information, please see license.txt

import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import nowtime, flt

from packaging_app.packaging_management_application.doctype.pack_fg.pack_fg import (
	allocate_bundle_qty_from_pool,
	get_batch_density,
	get_batch_doc_fields,
	get_bundle_total_qty,
	get_current_picks_from_bundle,
	get_default_wip_fg_warehouse,
	get_mutable_bundle_pool,
	link_inward_bundle_to_stock_entry,
)


class Repack(Document):
	def validate(self):
		self.validate_repack_finished_items()
		self.set_default_semi_product_filling_capacity()
		self.sync_semi_product_batches()
		self.create_semi_product_batches()
		self.validate_semi_product_items_item()
		self.validate_semi_product_items_for_stock_entry()
		self.validate_semi_product_items_batch()
		self.validate_semi_product_qty()
		self.validate_batch_bundle()
		self.validate_qty()

	def validate_semi_product_items_for_stock_entry(self):
		target_rows = [item for item in self.packed_fg_items if item.item_code]
		if not target_rows:
			frappe.throw(_("Add a Semi Product Item before submit"))
		if len(target_rows) > 1:
			frappe.throw(_("Only one Semi Product Item row is allowed"))

	def validate_semi_product_items_item(self):
		target_rows = [item for item in self.packed_fg_items if item.item_code]
		if len(target_rows) > 1:
			frappe.throw(_("Only one Semi Product Item row is allowed"))

		finished_items = get_finished_items_from_repack_rows(self.repack_items)
		if len(finished_items) > 1:
			frappe.throw(_("All Repack Items must have the same Finished Item"))

		if finished_items and target_rows and target_rows[0].item_code != finished_items[0]:
			frappe.throw(
				_("Semi Product Item must be {0} based on Repack Items").format(finished_items[0])
			)

	def validate_repack_finished_items(self):
		finished_items = get_finished_items_from_repack_rows(self.repack_items)
		if len(finished_items) > 1:
			frappe.throw(_("All Repack Items must have the same Finished Item"))

	def validate_batch_bundle(self):
		for item in self.repack_items:
			if not item.item_code:
				continue

			has_batch_no = frappe.db.get_value("Item", item.item_code, "has_batch_no")
			if has_batch_no and not item.serial_and_batch_bundle:
				frappe.throw(
					_("Please apply batch selection for item {0} using the Batch Selection table").format(
						item.item_code
					)
				)

	def set_default_semi_product_filling_capacity(self):
		for item in self.packed_fg_items:
			if not item.filling_capacity and item.item_code:
				item.filling_capacity = get_repack_filling_capacity(self.repack_items)

	def validate_semi_product_qty(self):
		for item in self.packed_fg_items:
			if item.item_code and not flt(item.qty):
				frappe.throw(
					_("Qty (Liters) is required for semi product item {0}").format(item.item_code)
				)

	def sync_semi_product_batches(self):
		if not self.batch_no:
			return

		source_density = get_batch_density(self.batch_no)
		for item in self.packed_fg_items:
			if not item.item_code:
				continue

			has_batch_no = frappe.get_cached_value("Item", item.item_code, "has_batch_no")
			if has_batch_no and not item.batch:
				item.batch = resolve_repack_semi_product_batch_id(self.batch_no, item.item_code)
				item.density = source_density
			elif has_batch_no:
				item.density = source_density
			elif not has_batch_no:
				item.batch = None
				item.density = None

	def create_semi_product_batches(self):
		for item in self.packed_fg_items:
			if not item.item_code or not item.batch:
				continue

			if not frappe.get_cached_value("Item", item.item_code, "has_batch_no"):
				continue

			batch_no = get_repack_semi_product_batch_id(self.batch_no, item.item_code, item.batch)
			item.batch = create_repack_semi_product_batch(
				batch_no=batch_no,
				item_code=item.item_code,
				repack_doc=self,
				source_batch_no=self.batch_no,
			)

	def validate_semi_product_items_batch(self):
		for item in self.packed_fg_items:
			if not item.item_code:
				continue

			has_batch_no = frappe.get_cached_value("Item", item.item_code, "has_batch_no")
			if has_batch_no and not item.batch:
				frappe.throw(_("Batch is required for semi product item {0}").format(item.item_code))
			if not has_batch_no:
				item.batch = None
				item.density = None

	def sync_repack_qty_from_bundle(self):
		for item in self.repack_items:
			if item.serial_and_batch_bundle:
				item.qty = get_bundle_total_qty(item.serial_and_batch_bundle)

	def validate_qty(self):
		self.sync_repack_qty_from_bundle()

		repack_qty = sum(flt(item.qty) for item in self.repack_items)
		semi_product_pack_qty = sum(flt(item.pack_qty) for item in self.packed_fg_items)
		precision = frappe.get_precision("Repack FG Item Code", "qty") or 3

		if flt(repack_qty, precision) != flt(semi_product_pack_qty, precision):
			repack_row = self.repack_items[0] if self.repack_items else None
			current_picks = get_current_picks_from_repack_items(self.repack_items)
			frappe.throw(
				build_qty_mismatch_message(
					pick_qty=repack_qty,
					semi_product_pack_qty=semi_product_pack_qty,
					company=self.company,
					item_code=repack_row.item_code if repack_row else None,
					source_warehouse=repack_row.source_warehouse if repack_row else None,
					current_picks=current_picks,
					serial_and_batch_bundle=repack_row.serial_and_batch_bundle
					if repack_row
					else None,
					posting_date=self.posting_date,
					posting_time=self.posting_time,
					precision=precision,
				)
			)

	def on_submit(self):
		self.create_stock_entry()

	def on_cancel(self):
		self.cancel_stock_entry()

	def create_stock_entry(self):
		"""Create one Stock Entry: all repack items out, semi-product row(s) in."""
		repack_rows = [row for row in self.repack_items if row.item_code]
		target_rows = [item for item in self.packed_fg_items if item.item_code]

		if not repack_rows:
			frappe.throw(_("Add a Repack Item before submit"))
		if not target_rows:
			frappe.throw(_("Add a Semi Product Item before submit"))

		se = frappe.new_doc("Stock Entry")
		se.stock_entry_type = "Repack"
		se.purpose = "Repack"
		se.custom_repack = self.name
		se.company = self.company
		se.posting_date = self.posting_date
		se.posting_time = self.posting_time or nowtime()
		se.set_posting_time = 1

		for repack_row in repack_rows:
			outward_qty = flt(repack_row.qty)
			if not outward_qty:
				frappe.throw(_("Qty is required for repack item {0}").format(repack_row.item_code))

			source_item = {
				"s_warehouse": repack_row.source_warehouse,
				"item_code": repack_row.item_code,
				"qty": outward_qty,
				"transfer_qty": outward_qty,
				"uom": repack_row.uom,
				"use_serial_batch_fields": 1,
			}

			if repack_row.serial_and_batch_bundle:
				source_item["serial_and_batch_bundle"] = create_outward_bundle_for_repack_row(
					repack_row, self
				)
				source_item["use_serial_batch_fields"] = 0

			se.append("items", source_item)

		for target_item in target_rows:
			if not flt(target_item.pack_qty):
				frappe.throw(
					_("Pack Qty is required for semi product item {0}").format(target_item.item_code)
				)

			semi_product_qty = flt(target_item.qty)
			if not semi_product_qty:
				frappe.throw(
					_("Qty is required for semi product item {0}").format(target_item.item_code)
				)

			stock_uom = frappe.get_cached_value("Item", target_item.item_code, "stock_uom")
			has_batch_no = frappe.get_cached_value("Item", target_item.item_code, "has_batch_no")

			target_item_row = {
				"t_warehouse": target_item.target_warehouse,
				"item_code": target_item.item_code,
				"qty": semi_product_qty,
				"transfer_qty": semi_product_qty,
				"uom": stock_uom,
				"stock_uom": stock_uom,
				"conversion_factor": 1,
				"is_finished_item": 1,
				"use_serial_batch_fields": 0,
			}

			if has_batch_no:
				batch_no = target_item.batch
				if not batch_no:
					frappe.throw(
						_("Batch is required for semi product item {0}").format(target_item.item_code)
					)

				if not frappe.db.exists("Batch", batch_no):
					frappe.throw(
						_(
							"Batch {0} does not exist for semi product item {1}. Please save the document first."
						).format(batch_no, target_item.item_code)
					)

				target_item_row["batch_no"] = batch_no
				target_item_row["serial_and_batch_bundle"] = create_inward_bundle(
					target_item, self, semi_product_qty, batch_no
				)

			se.append("items", target_item_row)

		se.insert()
		link_inward_bundle_to_stock_entry(se)
		se.submit()

		frappe.msgprint(
			_("Stock Entry {0} created.").format(se.name),
			alert=True,
		)

	def cancel_stock_entry(self):
		stock_entries = frappe.get_all(
			"Stock Entry",
			filters={"custom_repack": self.name, "docstatus": 1},
			pluck="name",
			order_by="creation desc",
		)

		for se_name in stock_entries:
			se = frappe.get_doc("Stock Entry", se_name)
			se.cancel()
			frappe.msgprint(_("Stock Entry {0} cancelled").format(se.name), alert=True)


REPACK_BATCH_SEPARATOR_PATTERN = re.compile(r"[/.\\_~|:]+")
REPACK_BATCH_SUFFIX_LIMIT = 99


def normalize_repack_semi_product_batch_id(source_batch):
	"""Packed batch ID → semi-product batch ID using hyphens only."""
	batch = str(source_batch or "").strip()
	if not batch:
		return ""

	normalized = REPACK_BATCH_SEPARATOR_PATTERN.sub("-", batch)
	while "--" in normalized:
		normalized = normalized.replace("--", "-")

	return normalized.strip("-")


def _is_repack_batch_available(batch_no, item_code):
	if not frappe.db.exists("Batch", batch_no):
		return True
	return frappe.db.get_value("Batch", batch_no, "item") == item_code


def generate_repack_batch_suffix_candidates(base_batch_id):
	for suffix in range(1, REPACK_BATCH_SUFFIX_LIMIT + 1):
		yield f"{base_batch_id}-R{suffix}"


def resolve_repack_semi_product_batch_id(source_batch, item_code):
	"""Use normalized dash batch ID; reuse if it already exists for the semi-product item."""
	source_batch = str(source_batch or "").strip()
	normalized = normalize_repack_semi_product_batch_id(source_batch)

	candidates = []
	for candidate in (normalized, source_batch):
		if candidate and candidate not in candidates:
			candidates.append(candidate)

	for candidate in candidates:
		if _is_repack_batch_available(candidate, item_code):
			return candidate

	base_batch_id = normalized or source_batch
	for candidate in generate_repack_batch_suffix_candidates(base_batch_id):
		if _is_repack_batch_available(candidate, item_code):
			return candidate

	frappe.throw(_("No available batch name found for source batch {0}").format(source_batch))


def get_repack_semi_product_batch_id(source_batch_no, item_code, current_batch=None):
	if current_batch and frappe.db.exists("Batch", current_batch):
		if frappe.db.get_value("Batch", current_batch, "item") == item_code:
			return current_batch

	return resolve_repack_semi_product_batch_id(source_batch_no, item_code)


def resolve_packed_source_batch_no(source_batch_no):
	if not source_batch_no:
		return None

	source_batch_no = str(source_batch_no).strip()
	if frappe.db.exists("Batch", source_batch_no):
		return source_batch_no

	normalized = normalize_repack_semi_product_batch_id(source_batch_no)
	if normalized and normalized != source_batch_no and frappe.db.exists("Batch", normalized):
		return normalized

	return source_batch_no


def create_repack_semi_product_batch(batch_no, item_code, repack_doc, source_batch_no=None):
	if frappe.db.exists("Batch", batch_no):
		existing_item = frappe.db.get_value("Batch", batch_no, "item")
		if existing_item != item_code:
			frappe.throw(
				_("Batch {0} already exists for item {1}, not {2}").format(
					batch_no, existing_item, item_code
				)
			)
		return batch_no

	from erpnext.stock.doctype.batch.batch import make_batch

	repack_name = repack_doc.name if hasattr(repack_doc, "name") else repack_doc.get("name")
	batch_data = frappe._dict(
		{
			"item": item_code,
			"batch_id": batch_no,
		}
	)

	if repack_name and frappe.db.exists("Repack", repack_name):
		batch_data.update(
			{
				"reference_doctype": "Repack",
				"reference_name": repack_name,
			}
		)

	resolved_source_batch = resolve_packed_source_batch_no(source_batch_no)
	if resolved_source_batch:
		source_fields = ["expiry_date", "manufacturing_date"]
		if frappe.db.has_column("Batch", "custom_density"):
			source_fields.append("custom_density")

		source_batch = frappe.db.get_value(
			"Batch",
			resolved_source_batch,
			source_fields,
			as_dict=True,
		)
		if source_batch:
			batch_data.update(
				{
					"expiry_date": source_batch.expiry_date,
					"manufacturing_date": source_batch.manufacturing_date,
				}
			)
			if source_batch.get("custom_density") is not None:
				batch_data["custom_density"] = source_batch.custom_density

	return make_batch(batch_data)


@frappe.whitelist()
def get_repack_semi_product_batch_id_api(source_batch_no, item_code, current_batch=None):
	return get_repack_semi_product_batch_id(source_batch_no, item_code, current_batch)


@frappe.whitelist()
def create_and_link_semi_product_batches(source_batch_no, target_items, repack_name=None):
	if isinstance(target_items, str):
		target_items = frappe.parse_json(target_items)

	if not source_batch_no:
		frappe.throw(_("Source batch is required"))

	repack_doc = frappe._dict({"name": repack_name}) if repack_name else frappe._dict()
	source_density = get_batch_density(source_batch_no)
	rows = []
	semi_product_batch_id = None

	for row in target_items or []:
		item_code = row.get("item_code")
		if not item_code:
			continue

		if not frappe.get_cached_value("Item", item_code, "has_batch_no"):
			rows.append({"name": row.get("name"), "batch": None, "density": None})
			continue

		batch_no = get_repack_semi_product_batch_id(source_batch_no, item_code, row.get("batch"))
		batch_name = create_repack_semi_product_batch(
			batch_no=batch_no,
			item_code=item_code,
			repack_doc=repack_doc,
			source_batch_no=source_batch_no,
		)
		if semi_product_batch_id is None:
			semi_product_batch_id = batch_name
		rows.append({"name": row.get("name"), "batch": batch_name, "density": source_density})

	return {
		"semi_product_batch_id": semi_product_batch_id or "",
		"source_density": source_density,
		"rows": rows,
	}


def create_inward_bundle(target_item, repack_doc, qty, batch_no):
	bundle = frappe.get_doc(
		{
			"doctype": "Serial and Batch Bundle",
			"voucher_type": "Repack",
			"item_code": target_item.item_code,
			"warehouse": target_item.target_warehouse,
			"type_of_transaction": "Inward",
			"posting_date": repack_doc.posting_date,
			"posting_time": repack_doc.posting_time or nowtime(),
			"company": repack_doc.company,
		}
	)

	bundle.append(
		"entries",
		{
			"qty": abs(flt(qty)),
			"warehouse": target_item.target_warehouse,
			"batch_no": batch_no,
		},
	)

	bundle.save(ignore_permissions=True)
	return bundle.name


def create_outward_bundle_for_repack_row(repack_row, repack_doc):
	if not repack_row.serial_and_batch_bundle:
		frappe.throw(
			_("Row {0}: Apply batches before submitting.").format(repack_row.idx)
		)

	pool = get_mutable_bundle_pool(repack_row.serial_and_batch_bundle)
	entries = [
		{"batch_no": entry["batch_no"], "qty": entry["qty"]}
		for entry in pool
		if flt(entry["qty"]) > 0
	]
	if not entries:
		frappe.throw(
			_("Row {0}: No batch entries found in bundle {1}.").format(
				repack_row.idx, repack_row.serial_and_batch_bundle
			)
		)

	return create_outward_bundle(
		repack_row, repack_doc, entries, repack_row.source_warehouse
	)


def create_outward_bundle(repack_row, repack_doc, entries, warehouse):
	bundle = frappe.get_doc(
		{
			"doctype": "Serial and Batch Bundle",
			"voucher_type": "Repack",
			"item_code": repack_row.item_code,
			"warehouse": warehouse,
			"type_of_transaction": "Outward",
			"posting_date": repack_doc.posting_date,
			"posting_time": repack_doc.posting_time or nowtime(),
			"company": repack_doc.company,
		}
	)

	for row in entries:
		bundle.append(
			"entries",
			{
				"qty": -abs(flt(row["qty"])),
				"warehouse": warehouse,
				"batch_no": row["batch_no"],
			},
		)

	bundle.save(ignore_permissions=True)
	return bundle.name


def get_current_picks_from_repack_items(repack_items):
	picks = []
	for row in repack_items or []:
		if not row.serial_and_batch_bundle:
			continue
		picks.extend(
			get_current_picks_from_bundle(row.serial_and_batch_bundle, row.source_warehouse)
		)
	return picks


def normalize_current_picks(current_picks, serial_and_batch_bundle=None, source_warehouse=None):
	if isinstance(current_picks, str):
		current_picks = frappe.parse_json(current_picks)

	current_picks = current_picks or []
	if not current_picks and serial_and_batch_bundle:
		current_picks = get_current_picks_from_bundle(
			serial_and_batch_bundle, source_warehouse
		)
	return current_picks


def build_qty_mismatch_message(
	pick_qty,
	semi_product_pack_qty,
	company,
	item_code=None,
	source_warehouse=None,
	current_picks=None,
	serial_and_batch_bundle=None,
	posting_date=None,
	posting_time=None,
	precision=3,
):
	pick_qty = flt(pick_qty, precision)
	semi_product_pack_qty = flt(semi_product_pack_qty, precision)
	diff = flt(semi_product_pack_qty - pick_qty, precision)

	lines = [
		_(
			"Total Pick Qty ({0}) must equal Total Semi Product Pack Qty ({1}) across all semi product rows."
		).format(pick_qty, semi_product_pack_qty)
	]

	if diff > 0:
		lines.append(_("Short by {0} — add pick qty from:").format(diff))
	elif diff < 0:
		lines.append(_("Excess of {0} — reduce pick qty from:").format(abs(diff)))
	else:
		return "\n".join(lines)

	suggestions = get_qty_balance_suggestions(
		company=company,
		item_code=item_code,
		source_warehouse=source_warehouse,
		pick_qty=pick_qty,
		semi_product_pack_qty=semi_product_pack_qty,
		current_picks=current_picks or [],
		serial_and_batch_bundle=serial_and_batch_bundle,
		posting_date=posting_date,
		posting_time=posting_time,
		precision=precision,
	)

	for suggestion in suggestions.get("suggestions") or []:
		lines.append(format_qty_suggestion_line(suggestion))

	if suggestions.get("unfulfilled"):
		lines.append(
			_(
				"Could not fully cover {0} using available batches. Check stock in other warehouses or adjust Pack Qty."
			).format(suggestions["unfulfilled"])
		)

	if suggestions.get("pack_alternative"):
		lines.append(suggestions["pack_alternative"])

	return "\n".join(lines)


def format_qty_suggestion_line(suggestion):
	action = suggestion.get("action")
	batch_no = suggestion.get("batch_no")
	warehouse = suggestion.get("warehouse") or _("Unknown")
	qty = flt(suggestion.get("qty"))

	if action == "add":
		return _("• Add {0} from Batch {1} at {2}").format(qty, batch_no, warehouse)
	if action == "remove":
		return _("• Remove {0} from Batch {1} at {2}").format(qty, batch_no, warehouse)

	return _("• {0} {1} at {2}").format(qty, batch_no, warehouse)


def get_qty_balance_suggestions(
	company,
	item_code=None,
	source_warehouse=None,
	pick_qty=0,
	semi_product_pack_qty=0,
	current_picks=None,
	serial_and_batch_bundle=None,
	posting_date=None,
	posting_time=None,
	precision=3,
):
	pick_qty = flt(pick_qty, precision)
	semi_product_pack_qty = flt(semi_product_pack_qty, precision)
	diff = flt(semi_product_pack_qty - pick_qty, precision)

	result = {
		"pick_qty": pick_qty,
		"semi_product_pack_qty": semi_product_pack_qty,
		"difference": diff,
		"suggestions": [],
		"unfulfilled": 0,
		"pack_alternative": None,
	}

	if not diff:
		return result

	current_picks = normalize_current_picks(
		current_picks,
		serial_and_batch_bundle=serial_and_batch_bundle,
		source_warehouse=source_warehouse,
	)

	picks_map = {}
	for pick in current_picks:
		batch_no = pick.get("batch_no")
		if not batch_no:
			continue
		picks_map[batch_no] = picks_map.get(batch_no, 0) + flt(pick.get("qty"))

	if diff > 0:
		suggestions, remaining = build_add_pick_suggestions(
			company=company,
			item_code=item_code,
			source_warehouse=source_warehouse,
			needed_qty=diff,
			picks_map=picks_map,
			posting_date=posting_date,
			posting_time=posting_time,
		)
		result["suggestions"] = suggestions
		result["unfulfilled"] = flt(remaining, precision)
		result["pack_alternative"] = _(
			"Or reduce Pack Qty on Semi Product Items by {0} total."
		).format(diff)
	else:
		needed_remove = abs(diff)
		suggestions, remaining = build_remove_pick_suggestions(
			current_picks=current_picks,
			needed_remove=needed_remove,
		)
		result["suggestions"] = suggestions
		result["unfulfilled"] = flt(remaining, precision)
		result["pack_alternative"] = _(
			"Or increase Pack Qty on Semi Product Items by {0} total."
		).format(needed_remove)

	return result


def build_add_pick_suggestions(
	company,
	item_code,
	source_warehouse,
	needed_qty,
	picks_map,
	posting_date=None,
	posting_time=None,
):
	suggestions = []
	remaining = flt(needed_qty)
	seen_batches = set()

	warehouse_phases = []
	if source_warehouse:
		warehouse_phases.append(source_warehouse)
	warehouse_phases.append(None)

	for warehouse in warehouse_phases:
		if remaining <= 0:
			break

		batches = get_active_batches(
			company,
			item_code=item_code,
			warehouse=warehouse,
			posting_date=posting_date,
			posting_time=posting_time,
		)

		for batch in batches:
			if remaining <= 0:
				break

			batch_no = batch.get("batch_no")
			if batch_no in seen_batches:
				continue

			already_picked = flt(picks_map.get(batch_no))
			available_qty = flt(batch.get("available_qty"))
			can_add = min(max(available_qty - already_picked, 0), remaining)

			if can_add > 0:
				suggestions.append(
					{
						"action": "add",
						"batch_no": batch_no,
						"warehouse": batch.get("warehouse") or source_warehouse,
						"qty": can_add,
					}
				)
				seen_batches.add(batch_no)
				remaining -= can_add

	return suggestions, remaining


def build_remove_pick_suggestions(current_picks, needed_remove):
	suggestions = []
	remaining = flt(needed_remove)

	sorted_picks = sorted(
		[p for p in current_picks if flt(p.get("qty")) > 0],
		key=lambda row: flt(row.get("qty")),
		reverse=True,
	)

	for pick in sorted_picks:
		if remaining <= 0:
			break

		can_remove = min(flt(pick.get("qty")), remaining)
		if can_remove > 0:
			suggestions.append(
				{
					"action": "remove",
					"batch_no": pick.get("batch_no"),
					"warehouse": pick.get("warehouse"),
					"qty": can_remove,
				}
			)
			remaining -= can_remove

	return suggestions, remaining


@frappe.whitelist()
def get_qty_balance_suggestions_api(
	company,
	pick_qty,
	semi_product_pack_qty,
	item_code=None,
	source_warehouse=None,
	current_picks=None,
	serial_and_batch_bundle=None,
	posting_date=None,
	posting_time=None,
):
	precision = frappe.get_precision("Repack FG Item Code", "qty") or 3
	suggestions = get_qty_balance_suggestions(
		company=company,
		item_code=item_code,
		source_warehouse=source_warehouse,
		pick_qty=pick_qty,
		semi_product_pack_qty=semi_product_pack_qty,
		current_picks=current_picks,
		serial_and_batch_bundle=serial_and_batch_bundle,
		posting_date=posting_date,
		posting_time=posting_time,
		precision=precision,
	)
	suggestions["message"] = build_qty_mismatch_message(
		pick_qty=pick_qty,
		semi_product_pack_qty=semi_product_pack_qty,
		company=company,
		item_code=item_code,
		source_warehouse=source_warehouse,
		current_picks=current_picks,
		serial_and_batch_bundle=serial_and_batch_bundle,
		posting_date=posting_date,
		posting_time=posting_time,
		precision=precision,
	)
	return suggestions


@frappe.whitelist()
def get_repack_semi_product_info(repack_items=None):
	if isinstance(repack_items, str):
		repack_items = frappe.parse_json(repack_items)

	finished_items = []
	item_finished_map = {}
	item_batch_map = {}
	item_filling_capacity_map = {}
	filling_capacities = []

	for row in repack_items or []:
		item_code = row.get("item_code") if isinstance(row, dict) else getattr(row, "item_code", None)
		if not item_code:
			continue

		finished_item = frappe.get_cached_value("Item", item_code, "custom_finished_item")
		if finished_item:
			finished_items.append(finished_item)
			item_finished_map[item_code] = finished_item

		item_batch_map[item_code] = bool(
			frappe.get_cached_value("Item", item_code, "has_batch_no")
		)

		capacity = flt(frappe.get_cached_value("Item", item_code, "custom_filling_capacity"))
		item_filling_capacity_map[item_code] = capacity
		filling_capacities.append(capacity)

	unique_finished = list(dict.fromkeys(finished_items))
	unique_capacities = list(dict.fromkeys([c for c in filling_capacities if c]))

	finished_item = unique_finished[0] if len(unique_finished) == 1 else None
	filling_capacity = None
	if len(unique_capacities) == 1:
		filling_capacity = unique_capacities[0]
	elif len(unique_capacities) > 1:
		filling_capacity = None
	elif filling_capacities:
		filling_capacity = filling_capacities[0]

	item_name = None
	if finished_item:
		item_name = frappe.get_cached_value("Item", finished_item, "item_name")

	return {
		"finished_items": unique_finished,
		"finished_item": finished_item,
		"filling_capacity": filling_capacity,
		"item_name": item_name,
		"item_finished_map": item_finished_map,
		"item_batch_map": item_batch_map,
		"item_filling_capacity_map": item_filling_capacity_map,
	}


def get_finished_items_from_repack_rows(repack_items):
	finished_items = []
	for row in repack_items or []:
		if not row.item_code:
			continue
		finished_item = frappe.get_cached_value("Item", row.item_code, "custom_finished_item")
		if finished_item:
			finished_items.append(finished_item)
	return list(dict.fromkeys(finished_items))


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def get_repack_packed_items(doctype, txt, searchfield, start, page_len, filters):
	reference_packed_item = (filters or {}).get("reference_packed_item")
	exclude_items = (filters or {}).get("exclude_items") or []

	if isinstance(exclude_items, str):
		exclude_items = frappe.parse_json(exclude_items)

	finished_item = None
	if reference_packed_item:
		finished_item = frappe.get_cached_value("Item", reference_packed_item, "custom_finished_item")

	item_filters = {"item_group": "Packed Goods", "disabled": 0}
	if finished_item and frappe.db.has_column("Item", "custom_finished_item"):
		item_filters["custom_finished_item"] = finished_item

	if txt:
		item_filters["name"] = ["like", f"%{txt}%"]

	items = frappe.get_all(
		"Item",
		filters=item_filters,
		fields=["name", "item_name"],
		limit_start=start,
		limit_page_length=page_len,
		order_by="name asc",
	)

	if exclude_items:
		items = [item for item in items if item.name not in exclude_items]

	return [(item.name, item.item_name) for item in items]


def get_repack_filling_capacity(repack_items):
	capacities = []
	for row in repack_items or []:
		if not row.item_code:
			continue
		capacity = flt(frappe.get_cached_value("Item", row.item_code, "custom_filling_capacity"))
		if capacity:
			capacities.append(capacity)

	unique_capacities = list(dict.fromkeys(capacities))
	if len(unique_capacities) == 1:
		return unique_capacities[0]
	return unique_capacities[0] if unique_capacities else 0


@frappe.whitelist()
def get_active_batches_for_repack(
	company,
	repack_items=None,
	posting_date=None,
	posting_time=None,
	item_group="Packed Goods",
):
	if isinstance(repack_items, str):
		repack_items = frappe.parse_json(repack_items)

	rows = repack_items or []
	if not rows:
		return get_active_batches(
			company=company,
			posting_date=posting_date,
			posting_time=posting_time,
			item_group=item_group,
		)

	seen = set()
	batches = []
	for row in rows:
		item_code = row.get("item_code") if isinstance(row, dict) else None
		warehouse = row.get("source_warehouse") if isinstance(row, dict) else None
		if not item_code:
			continue

		key = (item_code, warehouse or "")
		if key in seen:
			continue
		seen.add(key)

		batches.extend(
			get_active_batches(
				company=company,
				item_code=item_code,
				warehouse=warehouse,
				posting_date=posting_date,
				posting_time=posting_time,
				item_group=item_group,
			)
		)

	return batches


@frappe.whitelist()
def get_semi_product_details(item_code):
	return get_semi_product_data(item_code)


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def get_item_semi_product(doctype, txt, searchfield, start, page_len, filters):
	packed_item_code = filters.get("item_code")
	exclude_items = filters.get("exclude_items") or []

	if isinstance(exclude_items, str):
		exclude_items = frappe.parse_json(exclude_items)

	data = get_semi_product_data(packed_item_code)

	if exclude_items:
		data = [d for d in data if d["item"] not in exclude_items]

	return [(d["item"], d["item_name"]) for d in data]


def get_semi_product_data(packed_item_code):
	if not packed_item_code:
		return []

	rows = frappe.get_all(
		"Packing Material Details",
		filters={
			"item": packed_item_code,
			"parenttype": "Item",
		},
		fields=["parent", "filling_capacity"],
	)

	if not rows:
		return []

	parent_items = list({row.parent for row in rows})
	item_filters = {"name": ["in", parent_items]}
	if frappe.db.has_column("Item", "custom_product_group"):
		item_filters["custom_product_group"] = "Finished Goods"

	item_names = {
		d.name: d.item_name
		for d in frappe.get_all(
			"Item",
			filters=item_filters,
			fields=["name", "item_name"],
		)
	}

	return [
		{
			"item": row.parent,
			"item_name": item_names.get(row.parent, row.parent),
			"filling_capacity": row.filling_capacity,
		}
		for row in rows
		if row.parent in item_names
	]


def filter_batches_by_item_group(batches, item_group="Packed Goods"):
	if not item_group or not batches:
		return batches

	item_codes = list({batch.get("item_code") for batch in batches if batch.get("item_code")})
	if not item_codes:
		return batches

	allowed_items = set(
		frappe.get_all(
			"Item",
			filters={"name": ["in", item_codes], "item_group": item_group},
			pluck="name",
		)
	)
	return [batch for batch in batches if batch.get("item_code") in allowed_items]


@frappe.whitelist()
def get_default_wip_fg_warehouse_api(company):
	return get_default_wip_fg_warehouse(company)


@frappe.whitelist()
def get_active_batches(
	company,
	item_code=None,
	warehouse=None,
	posting_date=None,
	posting_time=None,
	item_group="Packed Goods",
):
	from erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle import (
		get_auto_batch_nos,
	)

	if not company:
		frappe.throw(_("Company is required"))

	if not warehouse:
		warehouse = get_default_wip_fg_warehouse(company)

	kwargs = frappe._dict(
		{
			"company": company,
			"posting_date": posting_date,
			"posting_time": posting_time or nowtime(),
			"for_stock_levels": False,
		}
	)

	if item_code:
		kwargs.item_code = item_code
	if warehouse:
		kwargs.warehouse = warehouse

	batches = get_auto_batch_nos(kwargs)
	if not batches:
		return []

	batch_nos = list({batch.batch_no for batch in batches})
	batch_items = {
		d.name: d
		for d in frappe.get_all(
			"Batch",
			filters={"name": ["in", batch_nos]},
			fields=get_batch_doc_fields(),
		)
	}

	item_codes = list({d.item for d in batch_items.values() if d.item})
	item_names = {}
	item_filling_capacities = {}
	if item_codes:
		item_fields = ["name", "item_name"]
		if frappe.db.has_column("Item", "custom_filling_capacity"):
			item_fields.append("custom_filling_capacity")

		for item in frappe.get_all(
			"Item",
			filters={"name": ["in", item_codes]},
			fields=item_fields,
		):
			item_names[item.name] = item.item_name
			if "custom_filling_capacity" in item_fields:
				item_filling_capacities[item.name] = flt(item.get("custom_filling_capacity"))

	result = []
	for batch in batches:
		batch_doc = batch_items.get(batch.batch_no)
		if not batch_doc:
			continue

		batch_item_code = batch_doc.item
		item_name = item_names.get(batch_item_code)
		if item_name == batch_item_code:
			item_name = None
		result.append(
			{
				"batch_no": batch.batch_no,
				"item_code": batch_item_code,
				"item_name": item_name,
				"warehouse": batch.warehouse,
				"available_qty": flt(batch.qty),
				"expiry_date": batch.expiry_date or batch_doc.expiry_date,
				"density": flt(batch_doc.get("custom_density")),
				"filling_capacity": item_filling_capacities.get(batch_item_code, 0),
			}
		)

	return filter_batches_by_item_group(result, item_group)
