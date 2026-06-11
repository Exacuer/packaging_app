# Copyright (c) 2026, Vivek Choudhary and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import nowtime, flt


class PackFG(Document):
	def validate(self):
		self.calculate_packed_qty()
		self.validate_packed_fg_items_item()
		self.validate_packed_fg_items_for_stock_entry()
		self.validate_batch_bundle()
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

	def sync_packing_qty_from_bundle(self):
		"""Set packing_items qty from serial_and_batch_bundle total (all batch picks)."""
		for item in self.packing_items:
			if item.serial_and_batch_bundle:
				item.qty = get_bundle_total_qty(item.serial_and_batch_bundle)

	def validate_qty(self):
		"""Validate total picked qty equals sum of all packed_fg_items rows."""
		self.sync_packing_qty_from_bundle()

		packing_qty = sum(flt(item.qty) for item in self.packing_items)
		packed_qty = sum(flt(item.qty) for item in self.packed_fg_items)
		precision = frappe.get_precision("Pack FG Item Source", "qty") or 3

		if flt(packing_qty, precision) != flt(packed_qty, precision):
			frappe.throw(
				_(
					"Total Pick Qty ({0}) from batches must equal Total Packed FG Items Qty ({1}). "
					"Update batch picks and click Apply Batches, or adjust Pack Qty on all packed rows."
				).format(packing_qty, packed_qty)
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

		for packed_item in packed_rows:
			if not flt(packed_item.pack_qty):
				frappe.throw(
					_("Pack Qty is required for packed item {0}").format(packed_item.item_code)
				)

			source_qty = flt(packed_item.qty)
			pack_qty = flt(packed_item.pack_qty)
			bundle_entries, bundle_pool = allocate_bundle_qty_from_pool(bundle_pool, source_qty)

			se = frappe.new_doc("Stock Entry")
			se.stock_entry_type = "Repack"
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

			stock_uom = frappe.get_cached_value("Item", packed_item.item_code, "stock_uom")
			se.append(
				"items",
				{
					"t_warehouse": packed_item.target_warehouse,
					"item_code": packed_item.item_code,
					"qty": pack_qty,
					"transfer_qty": pack_qty,
					"uom": stock_uom,
					"stock_uom": stock_uom,
					"conversion_factor": 1,
					"is_finished_item": 1,
					"use_serial_batch_fields": 1,
				},
			)

			se.insert()
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


@frappe.whitelist()
def get_packaging_material_details(item_code):
	return get_packaging_material_data(item_code)


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
			"item",
			"packing_item_name",
			"filling_capacity",
			"uom_sales",
			"weight_when_empty",
		],
	)


@frappe.whitelist()
def get_active_batches(company, item_code=None, warehouse=None, posting_date=None, posting_time=None):
	from erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle import get_auto_batch_nos

	if not company:
		frappe.throw(_("Company is required"))

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
			fields=["name", "item", "expiry_date"],
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
			}
		)

	return result