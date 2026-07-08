# Copyright (c) 2026, Vivek Choudhary and contributors
# For license information, please see license.txt

import frappe
from erpnext.stock.utils import get_stock_balance
from frappe import _
from frappe.model.document import Document
from frappe.utils import nowtime, flt


class PackFG(Document):
	def validate(self):
		self.calculate_packed_qty()
		self.sync_packed_fg_batches()
		self.create_packed_fg_batches()
		self.validate_packed_fg_items_item()
		self.validate_packed_fg_items_for_stock_entry()
		self.validate_packed_fg_items_batch()
		self.validate_batch_bundle()
		self.validate_packed_fg_warehouse_stock()
		self.validate_qty()

	def validate_packed_fg_items_for_stock_entry(self):
		packed_rows = [item for item in self.packed_fg_items if item.item_code]
		if not packed_rows:
			frappe.throw(_("Add at least one Packed FG Item before submit"))

	def validate_packed_fg_items_item(self):
		seen_items = set()
		for item in self.packed_fg_items:
			if not item.item_code:
				continue
			if item.item_code in seen_items:
				frappe.throw(
					_("Item {0} is already selected in Packed FG Items").format(item.item_code)
				)
			seen_items.add(item.item_code)

	def validate_batch_bundle(self):
		for item in self.packing_items:
			if not item.item_code:
				continue

			has_batch_no = frappe.db.get_value("Item", item.item_code, "has_batch_no")
			if has_batch_no and not item.serial_and_batch_bundle:
				frappe.throw(
					_("Please apply batch selection for item {0} using the Batch Selection table").format(
						item.item_code
					)
				)

	def calculate_packed_qty(self):
		"""Calculate qty = filling_capacity * pack_qty for packed_fg_items"""
		for item in self.packed_fg_items:
			item.qty = flt(item.filling_capacity) * flt(item.pack_qty)

	def sync_packed_fg_batches(self):
		"""Set packed row batch ID when item has batch tracking enabled."""
		if not self.batch_no:
			return

		source_density = get_batch_density(self.batch_no)
		for item in self.packed_fg_items:
			if not item.item_code:
				continue

			has_batch_no = frappe.get_cached_value("Item", item.item_code, "has_batch_no")
			if has_batch_no and not item.batch:
				item.batch = resolve_packed_fg_batch_id(self.batch_no, item.item_code)
				item.density = source_density
			elif has_batch_no:
				item.density = source_density
			elif not has_batch_no:
				item.batch = None
				item.density = None

	def create_packed_fg_batches(self):
		"""Ensure Batch records exist for packed rows on save."""
		for item in self.packed_fg_items:
			if not item.item_code or not item.batch:
				continue

			if not frappe.get_cached_value("Item", item.item_code, "has_batch_no"):
				continue

			batch_no = get_packed_fg_batch_id(self.batch_no, item.item_code, item.batch)
			item.batch = create_packed_fg_batch(
				batch_no=batch_no,
				item_code=item.item_code,
				pack_fg_doc=self,
				source_batch_no=self.batch_no,
			)

	def validate_packed_fg_items_batch(self):
		for item in self.packed_fg_items:
			if not item.item_code:
				continue

			has_batch_no = frappe.get_cached_value("Item", item.item_code, "has_batch_no")
			if has_batch_no and not item.batch:
				frappe.throw(
					_("Batch is required for packed item {0}").format(item.item_code)
				)
			if not has_batch_no:
				item.batch = None
				item.density = None

	def sync_packing_qty_from_bundle(self):
		"""Set packing_items qty from serial_and_batch_bundle total (all batch picks)."""
		for item in self.packing_items:
			if item.serial_and_batch_bundle:
				item.qty = get_bundle_total_qty(item.serial_and_batch_bundle)

	def validate_packed_fg_warehouse_stock(self):
		packing_row = next((row for row in self.packing_items if row.item_code), None)
		if not packing_row:
			return

		validate_packed_fg_warehouse_stock(
			source_fg_item=packing_row.item_code,
			source_warehouse=packing_row.source_warehouse,
			packed_fg_items=self.packed_fg_items,
			posting_date=self.posting_date,
			posting_time=self.posting_time,
		)

	def validate_qty(self):
		"""Validate total picked qty equals sum of all packed_fg_items rows."""
		self.sync_packing_qty_from_bundle()

		packing_qty = sum(flt(item.qty) for item in self.packing_items)
		packed_qty = sum(flt(item.qty) for item in self.packed_fg_items)
		precision = frappe.get_precision("Pack FG Item Source", "qty") or 3

		if flt(packing_qty, precision) != flt(packed_qty, precision):
			packing_row = self.packing_items[0] if self.packing_items else None
			current_picks = get_current_picks_from_packing_items(self.packing_items)
			frappe.throw(
				build_qty_mismatch_message(
					pick_qty=packing_qty,
					packed_qty=packed_qty,
					company=self.company,
					item_code=packing_row.item_code if packing_row else None,
					source_warehouse=packing_row.source_warehouse if packing_row else None,
					current_picks=current_picks,
					serial_and_batch_bundle=packing_row.serial_and_batch_bundle
					if packing_row
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
		"""Create one Stock Entry per packed_fg_items row; incoming qty uses pack_qty."""
		packed_rows = [item for item in self.packed_fg_items if item.item_code]
		if not self.packing_items:
			frappe.throw(_("Add a Packing Item before submit"))

		packing_row = self.packing_items[0]
		bundle_pool = get_mutable_bundle_pool(packing_row.serial_and_batch_bundle)
		stock_entry_names = []
		packing_item_code_map = get_packing_item_code_map(packing_row.item_code)

		for packed_item in packed_rows:
			if not flt(packed_item.pack_qty):
				frappe.throw(
					_("Pack Qty is required for packed item {0}").format(packed_item.item_code)
				)

			source_qty = flt(packed_item.qty)
			pack_qty = flt(packed_item.pack_qty)
			bundle_entries, bundle_pool = allocate_bundle_qty_from_pool(bundle_pool, source_qty)

			se = frappe.new_doc("Stock Entry")
			se.stock_entry_type = "Packing"
			se.purpose = "Repack"
			se.custom_pack_fg = self.name
			se.company = self.company
			se.posting_date = self.posting_date
			se.posting_time = self.posting_time or nowtime()

			source_item = {
				"s_warehouse": packing_row.source_warehouse,
				"item_code": packing_row.item_code,
				"qty": source_qty,
				"transfer_qty": source_qty,
				"uom": packing_row.uom,
				"use_serial_batch_fields": 1,
			}

			if bundle_entries:
				source_item["serial_and_batch_bundle"] = create_outward_bundle(
					packing_row, self, bundle_entries, packing_row.source_warehouse
				)
				source_item["use_serial_batch_fields"] = 0

			se.append("items", source_item)

			packing_item_code = packing_item_code_map.get(packed_item.item_code)
			if packing_item_code:
				can_uom = frappe.get_cached_value("Item", packing_item_code, "stock_uom")
				se.append(
					"items",
					{
						"s_warehouse": packing_row.source_warehouse,
						"item_code": packing_item_code,
						"qty": pack_qty,
						"transfer_qty": pack_qty,
						"uom": can_uom,
						"stock_uom": can_uom,
						"conversion_factor": 1,
						"use_serial_batch_fields": 1,
					},
				)

			stock_uom = frappe.get_cached_value("Item", packed_item.item_code, "stock_uom")

			has_batch_no = frappe.get_cached_value("Item", packed_item.item_code, "has_batch_no")

			target_item = {
				"t_warehouse": packed_item.target_warehouse,
				"item_code": packed_item.item_code,
				"qty": pack_qty,
				"transfer_qty": pack_qty,
				"uom": stock_uom,
				"stock_uom": stock_uom,
				"conversion_factor": 1,
				"is_finished_item": 1,
				"use_serial_batch_fields": 0,
			}

			if has_batch_no:
				batch_no = packed_item.batch
				if not batch_no:
					frappe.throw(
						_("Batch is required for packed item {0}").format(packed_item.item_code)
					)

				if not frappe.db.exists("Batch", batch_no):
					frappe.throw(
						_("Batch {0} does not exist for packed item {1}. Please save the document first.").format(
							batch_no, packed_item.item_code
						)
					)

				target_item["batch_no"] = batch_no
				target_item["serial_and_batch_bundle"] = create_inward_bundle(
					packed_item, self, pack_qty, batch_no
				)

			se.append("items", target_item)

			se.insert()
			link_inward_bundle_to_stock_entry(se)
			se.submit()
			stock_entry_names.append(se.name)

		if frappe.db.has_column("Pack FG", "stock_entry") and stock_entry_names:
			frappe.db.set_value("Pack FG", self.name, "stock_entry", stock_entry_names[0])

		frappe.msgprint(
			_("Stock Entries {0} created ({1} packed item(s))").format(
				", ".join(stock_entry_names), len(stock_entry_names)
			),
			alert=True,
		)

	def cancel_stock_entry(self):
		"""Cancel all Stock Entries linked to this Pack FG."""
		stock_entries = frappe.get_all(
			"Stock Entry",
			filters={"custom_pack_fg": self.name, "docstatus": 1},
			pluck="name",
			order_by="creation desc",
		)

		for se_name in stock_entries:
			se = frappe.get_doc("Stock Entry", se_name)
			se.cancel()
			frappe.msgprint(_("Stock Entry {0} cancelled").format(se.name), alert=True)



	
def get_mutable_bundle_pool(bundle_name):
	if not bundle_name:
		return []

	entries = frappe.get_all(
		"Serial and Batch Entry",
		filters={"parent": bundle_name},
		fields=["batch_no", "qty"],
		order_by="idx",
	)
	return [{"batch_no": entry.batch_no, "qty": abs(flt(entry.qty))} for entry in entries]


def allocate_bundle_qty_from_pool(pool, qty_needed):
	entries = []
	remaining = flt(qty_needed)
	updated_pool = []

	for item in pool:
		if remaining <= 0:
			updated_pool.append(item)
			continue

		available = flt(item["qty"])
		take = min(available, remaining)

		if take > 0:
			entries.append({"batch_no": item["batch_no"], "qty": take})
			remaining -= take
			available -= take

		if available > 0:
			updated_pool.append({"batch_no": item["batch_no"], "qty": available})

	if remaining > 0:
		frappe.throw(
			_("Insufficient batch quantity in bundle. Required {0}, short by {1}").format(
				qty_needed, remaining
			)
		)

	return entries, updated_pool


PACKED_FG_BATCH_SEPARATORS = ("/", ".", "\\", "_", "~", "|", ":")
PACKED_FG_BATCH_SUFFIX_LIMIT = 99


def _split_batch_segments(source_batch):
	"""Split a batch ID on hyphen or slash separators."""
	normalized = str(source_batch).replace("/", "-")
	if "-" in normalized:
		return normalized.split("-")
	return [normalized]


def _yield_unique_candidate(candidate, seen):
	if candidate and candidate not in seen:
		seen.add(candidate)
		return candidate
	return None


def _is_packed_fg_batch_available(batch_no, item_code):
	if not frappe.db.exists("Batch", batch_no):
		return True
	return frappe.db.get_value("Batch", batch_no, "item") == item_code


def generate_packed_fg_batch_candidates(source_batch):
	"""Yield alternate packed FG batch IDs using different separators."""
	source_batch = str(source_batch or "").strip()
	if not source_batch:
		return

	segments = _split_batch_segments(source_batch)
	if len(segments) <= 1:
		yield source_batch
		return

	source_sep = "/" if "/" in source_batch else "-"
	seen = set()

	def add_candidate(sep):
		candidate = _yield_unique_candidate(sep.join(segments), seen)
		if candidate:
			yield candidate

		double_sep = sep * 2
		if double_sep != sep:
			candidate = _yield_unique_candidate(double_sep.join(segments), seen)
			if candidate:
				yield candidate

	primary_sep = "/" if source_sep == "-" else "-"
	yield from add_candidate(primary_sep)

	for sep in PACKED_FG_BATCH_SEPARATORS:
		if sep == source_sep:
			continue
		yield from add_candidate(sep)

	if source_sep != "-":
		candidate = _yield_unique_candidate("-".join(segments), seen)
		if candidate:
			yield candidate


def generate_packed_fg_batch_suffix_candidates(base_batch_id):
	"""Yield suffixed batch IDs as a last-resort unique fallback."""
	for suffix in range(1, PACKED_FG_BATCH_SUFFIX_LIMIT + 1):
		yield f"{base_batch_id}-P{suffix}"


def alternate_packed_fg_batch_id(source_batch):
	"""Return the primary alternate batch ID format (dash ↔ slash)."""
	for candidate in generate_packed_fg_batch_candidates(source_batch):
		return candidate
	return ""


def resolve_packed_fg_batch_id(source_batch, item_code):
	"""Pick the first batch ID that is unused or already belongs to item_code."""
	for candidate in generate_packed_fg_batch_candidates(source_batch):
		if _is_packed_fg_batch_available(candidate, item_code):
			return candidate

	base_batch_id = alternate_packed_fg_batch_id(source_batch) or str(source_batch)
	for candidate in generate_packed_fg_batch_suffix_candidates(base_batch_id):
		if _is_packed_fg_batch_available(candidate, item_code):
			return candidate

	frappe.throw(
		_("No available batch name found for source batch {0}").format(source_batch)
	)


def get_packed_fg_batch_id(source_batch_no, item_code, current_batch=None):
	"""Reuse current batch when valid; otherwise resolve an available alternate ID."""
	if current_batch and frappe.db.exists("Batch", current_batch):
		if frappe.db.get_value("Batch", current_batch, "item") == item_code:
			return current_batch

	return resolve_packed_fg_batch_id(source_batch_no, item_code)


def resolve_source_batch_no(source_batch_no):
	if not source_batch_no:
		return None

	if frappe.db.exists("Batch", source_batch_no):
		return source_batch_no

	alternate = alternate_packed_fg_batch_id(source_batch_no)
	if frappe.db.exists("Batch", alternate):
		return alternate

	return source_batch_no


def create_packed_fg_batch(batch_no, item_code, pack_fg_doc, source_batch_no=None):
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

	pack_fg_name = pack_fg_doc.name if hasattr(pack_fg_doc, "name") else pack_fg_doc.get("name")
	batch_data = frappe._dict(
		{
			"item": item_code,
			"batch_id": batch_no,
		}
	)

	if pack_fg_name and frappe.db.exists("Pack FG", pack_fg_name):
		batch_data.update(
			{
				"reference_doctype": "Pack FG",
				"reference_name": pack_fg_name,
			}
		)

	resolved_source_batch = resolve_source_batch_no(source_batch_no)
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


def get_batch_doc_fields():
	fields = ["name", "item", "expiry_date"]
	if frappe.db.has_column("Batch", "custom_density"):
		fields.append("custom_density")
	return fields


def get_batch_density(batch_no):
	if not batch_no or not frappe.db.has_column("Batch", "custom_density"):
		return None

	return flt(frappe.db.get_value("Batch", batch_no, "custom_density"))


@frappe.whitelist()
def create_and_link_packed_fg_batches(source_batch_no, packed_items, pack_fg_name=None):
	"""Create packed FG batches in alternate ID format and return row links."""
	if isinstance(packed_items, str):
		packed_items = frappe.parse_json(packed_items)

	if not source_batch_no:
		frappe.throw(_("Source batch is required"))

	pack_fg_doc = frappe._dict({"name": pack_fg_name}) if pack_fg_name else frappe._dict()
	source_density = get_batch_density(source_batch_no)
	rows = []
	packed_batch_id = None

	for row in packed_items or []:
		item_code = row.get("item_code")
		if not item_code:
			continue

		if not frappe.get_cached_value("Item", item_code, "has_batch_no"):
			rows.append({"name": row.get("name"), "batch": None, "density": None})
			continue

		batch_no = get_packed_fg_batch_id(source_batch_no, item_code, row.get("batch"))
		batch_name = create_packed_fg_batch(
			batch_no=batch_no,
			item_code=item_code,
			pack_fg_doc=pack_fg_doc,
			source_batch_no=source_batch_no,
		)
		if packed_batch_id is None:
			packed_batch_id = batch_name
		rows.append({"name": row.get("name"), "batch": batch_name, "density": source_density})

	return {
		"packed_batch_id": packed_batch_id or "",
		"source_density": source_density,
		"rows": rows,
	}


def link_inward_bundle_to_stock_entry(stock_entry):
	"""Link inward bundles on finished items to the Stock Entry voucher."""
	for row in stock_entry.items:
		if not row.is_finished_item or not row.serial_and_batch_bundle:
			continue

		frappe.db.set_value(
			"Serial and Batch Bundle",
			row.serial_and_batch_bundle,
			{
				"voucher_type": "Stock Entry",
				"voucher_no": stock_entry.name,
				"voucher_detail_no": row.name,
			},
		)


def create_inward_bundle(packed_item, pack_fg_doc, pack_qty, batch_no):
	bundle = frappe.get_doc(
		{
			"doctype": "Serial and Batch Bundle",
			"voucher_type": "Pack FG",
			"item_code": packed_item.item_code,
			"warehouse": packed_item.target_warehouse,
			"type_of_transaction": "Inward",
			"posting_date": pack_fg_doc.posting_date,
			"posting_time": pack_fg_doc.posting_time or nowtime(),
			"company": pack_fg_doc.company,
		}
	)

	bundle.append(
		"entries",
		{
			"qty": abs(flt(pack_qty)),
			"warehouse": packed_item.target_warehouse,
			"batch_no": batch_no,
		},
	)

	bundle.save(ignore_permissions=True)
	return bundle.name


def create_outward_bundle(packing_row, pack_fg_doc, entries, warehouse):
	bundle = frappe.get_doc(
		{
			"doctype": "Serial and Batch Bundle",
			"voucher_type": "Pack FG",
			"item_code": packing_row.item_code,
			"warehouse": warehouse,
			"type_of_transaction": "Outward",
			"posting_date": pack_fg_doc.posting_date,
			"posting_time": pack_fg_doc.posting_time or nowtime(),
			"company": pack_fg_doc.company,
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


def get_bundle_total_qty(bundle_name):
	if not bundle_name:
		return 0

	entries = frappe.get_all(
		"Serial and Batch Entry",
		filters={"parent": bundle_name},
		fields=["qty"],
	)
	return sum(abs(flt(entry.qty)) for entry in entries)


def get_current_picks_from_bundle(bundle_name, warehouse=None):
	if not bundle_name:
		return []

	picks = []
	entries = frappe.get_all(
		"Serial and Batch Entry",
		filters={"parent": bundle_name},
		fields=["batch_no", "qty"],
		order_by="idx",
	)
	for entry in entries:
		qty = abs(flt(entry.qty))
		if qty > 0:
			picks.append(
				{
					"batch_no": entry.batch_no,
					"qty": qty,
					"warehouse": warehouse,
				}
			)
	return picks


def get_current_picks_from_packing_items(packing_items):
	picks = []
	for row in packing_items or []:
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
	packed_qty,
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
	packed_qty = flt(packed_qty, precision)
	diff = flt(packed_qty - pick_qty, precision)

	lines = [
		_(
			"Total Pick Qty ({0}) must equal Total Packed FG Items Qty ({1}) across all packed rows."
		).format(pick_qty, packed_qty)
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
		packed_qty=packed_qty,
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
	packed_qty=0,
	current_picks=None,
	serial_and_batch_bundle=None,
	posting_date=None,
	posting_time=None,
	precision=3,
):
	pick_qty = flt(pick_qty, precision)
	packed_qty = flt(packed_qty, precision)
	diff = flt(packed_qty - pick_qty, precision)

	result = {
		"pick_qty": pick_qty,
		"packed_qty": packed_qty,
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
			"Or reduce Pack Qty on Packed FG Items by {0} liters total."
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
			"Or increase Pack Qty on Packed FG Items by {0} liters total."
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
	packed_qty,
	item_code=None,
	source_warehouse=None,
	current_picks=None,
	serial_and_batch_bundle=None,
	posting_date=None,
	posting_time=None,
):
	precision = frappe.get_precision("Pack FG Item Source", "qty") or 3
	suggestions = get_qty_balance_suggestions(
		company=company,
		item_code=item_code,
		source_warehouse=source_warehouse,
		pick_qty=pick_qty,
		packed_qty=packed_qty,
		current_picks=current_picks,
		serial_and_batch_bundle=serial_and_batch_bundle,
		posting_date=posting_date,
		posting_time=posting_time,
		precision=precision,
	)
	suggestions["message"] = build_qty_mismatch_message(
		pick_qty=pick_qty,
		packed_qty=packed_qty,
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
def get_packaging_material_details(item_code):
	return get_packaging_material_data(item_code)


def get_packing_item_code_map(source_item_code):
	return {
		row["item"]: row.get("packing_item_code") or row["item"]
		for row in get_packaging_material_data(source_item_code)
		if row.get("item")
	}


def validate_packed_fg_warehouse_stock(
	source_fg_item,
	source_warehouse,
	packed_fg_items,
	posting_date=None,
	posting_time=None,
):
	if not source_fg_item or not source_warehouse:
		return

	if isinstance(packed_fg_items, str):
		packed_fg_items = frappe.parse_json(packed_fg_items)

	item_code_map = get_packing_item_code_map(source_fg_item)
	pack_precision = frappe.get_precision("Pack FG Item Target", "pack_qty") or 3

	for item in packed_fg_items or []:
		item_code = item.get("item_code") if isinstance(item, dict) else item.item_code
		pack_qty = flt(item.get("pack_qty") if isinstance(item, dict) else item.pack_qty)
		row_qty = flt(item.get("qty") if isinstance(item, dict) else item.qty)

		if not item_code or not pack_qty:
			continue

		stock_item = item_code_map.get(item_code) or item_code
		available_qty = flt(
			get_stock_balance(
				stock_item,
				source_warehouse,
				posting_date=posting_date,
				posting_time=posting_time,
			)
		)

		if flt(pack_qty, pack_precision) > flt(available_qty, pack_precision):
			frappe.throw(
				_(
					"Packed FG Item {0} requires Pack Qty {1} (Qty {2}) but only {3} available in warehouse {4} for packing item {5}"
				).format(
					item_code,
					pack_qty,
					row_qty,
					available_qty,
					source_warehouse,
					stock_item,
				)
			)


@frappe.whitelist()
def validate_packed_fg_warehouse_stock_api(
	source_fg_item,
	source_warehouse,
	packed_fg_items,
	posting_date=None,
	posting_time=None,
):
	validate_packed_fg_warehouse_stock(
		source_fg_item=source_fg_item,
		source_warehouse=source_warehouse,
		packed_fg_items=packed_fg_items,
		posting_date=posting_date,
		posting_time=posting_time,
	)
	return {"ok": True}


@frappe.whitelist()
def get_packing_material_stock(
	item_code,
	warehouse,
	posting_date=None,
	posting_time=None,
):
	if not item_code or not warehouse:
		return {"warehouse": warehouse, "rows": []}

	rows = []
	for material in get_packaging_material_data(item_code):
		packing_item = material.get("item")
		packing_item_code = material.get("packing_item_code")
		stock_item = packing_item_code or packing_item
		if not stock_item:
			continue

		rows.append(
			{
				"packing_item_code": packing_item_code or packing_item,
				"item_code": packing_item,
				"item_name": material.get("packing_item_name")
				or frappe.get_cached_value("Item", stock_item, "item_name"),
				"packed_item": packing_item,
				"packed_item_name": frappe.get_cached_value("Item", packing_item, "item_name")
				if packing_item
				else "",
				"filling_capacity": flt(material.get("filling_capacity")),
				"warehouse_qty": flt(
					get_stock_balance(
						stock_item,
						warehouse,
						posting_date=posting_date,
						posting_time=posting_time,
					)
				),
			}
		)

	return {
		"warehouse": warehouse,
		"rows": rows,
	}


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def get_item_packaging_material(
	doctype,
	txt,
	searchfield,
	start,
	page_len,
	filters
):
	item_code = filters.get("item_code")
	exclude_items = filters.get("exclude_items") or []

	if isinstance(exclude_items, str):
		exclude_items = frappe.parse_json(exclude_items)

	data = get_packaging_material_data(item_code)

	if exclude_items:
		data = [d for d in data if d["item"] not in exclude_items]

	return [
		(
			d["item"],
			d["packing_item_name"]
		)
		for d in data
	]

def get_packaging_material_data(item_code):
	return frappe.get_all(
		"Packing Material Details",
		filters={
			"parent": item_code,
			"parenttype": "Item",
		},
		fields=[
			"packing_item_code",
			"item",
			"packing_item_name",
			"filling_capacity",
			"uom_sales",
			"weight_when_empty",
		],
	)


def get_default_wip_fg_warehouse(company):
	abbr = frappe.get_cached_value("Company", company, "abbr")
	if not abbr:
		return None

	warehouse = f"WIP FG - {abbr}"
	return warehouse if frappe.db.exists("Warehouse", warehouse) else None


def filter_batches_by_product_group(batches, product_group="Finished Goods"):
	if not product_group or not batches:
		return batches

	if not frappe.db.has_column("Item", "custom_product_group"):
		return batches

	item_codes = list({batch.get("item_code") for batch in batches if batch.get("item_code")})
	if not item_codes:
		return batches

	allowed_items = set(
		frappe.get_all(
			"Item",
			filters={"name": ["in", item_codes], "custom_product_group": product_group},
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
	product_group="Finished Goods",
):
	from erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle import get_auto_batch_nos

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
	if item_codes:
		item_names = {
			d.name: d.item_name
			for d in frappe.get_all(
				"Item",
				filters={"name": ["in", item_codes]},
				fields=["name", "item_name"],
			)
		}

	result = []
	for batch in batches:
		batch_doc = batch_items.get(batch.batch_no)
		if not batch_doc:
			continue

		batch_item_code = batch_doc.item
		result.append(
			{
				"batch_no": batch.batch_no,
				"item_code": batch_item_code,
				"item_name": item_names.get(batch_item_code),
				"warehouse": batch.warehouse,
				"available_qty": flt(batch.qty),
				"expiry_date": batch.expiry_date or batch_doc.expiry_date,
				"density": flt(batch_doc.get("custom_density")),
			}
		)

	return filter_batches_by_product_group(result, product_group)


@frappe.whitelist()
def get_pending_sales_order_qty(item_group=None):
	"""Pending (undelivered) Sales Order qty per item, totalled across ALL customers.

	Display-only helper for the "Create Sales Order" dialog on Pack FG. Sums
	(qty - delivered_qty) over every open, submitted Sales Order Item, grouped by item.
	"""
	conditions = ""
	values = {}
	if item_group:
		conditions = "AND item.item_group = %(item_group)s"
		values["item_group"] = item_group

	rows = frappe.db.sql(
		f"""
		SELECT
			soi.item_code,
			soi.item_name,
			soi.stock_uom AS uom,
			SUM(soi.qty - soi.delivered_qty) AS pending_qty
		FROM `tabSales Order Item` soi
		INNER JOIN `tabSales Order` so ON so.name = soi.parent
		INNER JOIN `tabItem` item ON item.name = soi.item_code
		WHERE so.docstatus = 1
			AND so.status NOT IN ('Closed', 'Completed')
			AND (soi.qty - soi.delivered_qty) > 0
			{conditions}
		GROUP BY soi.item_code, soi.item_name, soi.stock_uom
		HAVING pending_qty > 0
		ORDER BY pending_qty DESC
		""",
		values,
		as_dict=True,
	)

	for row in rows:
		row["pending_qty"] = flt(row.get("pending_qty"))

	return rows