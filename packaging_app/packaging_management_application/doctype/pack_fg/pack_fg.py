# Copyright (c) 2026, Vivek Choudhary and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import nowtime, flt


class PackFG(Document):
	def validate(self):
		self.calculate_packed_qty()
		self.validate_qty()

	def calculate_packed_qty(self):
		"""Calculate qty = filling_capacity * pack_qty for packed_fg_items"""
		for item in self.packed_fg_items:
			item.qty = flt(item.filling_capacity) * flt(item.pack_qty)

	def validate_qty(self):
		"""Validate that packing_items qty equals packed_fg_items qty"""
		packing_qty = sum(flt(item.qty) for item in self.packing_items)
		packed_qty = sum(flt(item.qty) for item in self.packed_fg_items)

		if packing_qty != packed_qty:
			frappe.throw(
				_("Total Packing Items Qty ({0}) must equal Total Packed FG Items Qty ({1})").format(
					packing_qty, packed_qty
				)
			)

	def on_submit(self):
		self.create_stock_entry()

	def on_cancel(self):
		self.cancel_stock_entry()

	def create_stock_entry(self):
		"""Create Stock Entry (Repack) on submit"""
		se = frappe.new_doc("Stock Entry")
		se.stock_entry_type = "Repack"
		se.purpose = "Repack"
		se.custom_pack_fg = self.name  # Link back to Pack FG
		se.company = self.company
		se.posting_date = self.posting_date
		se.posting_time = self.posting_time or nowtime()

		# Add source items (outgoing - from packing_items)
		for item in self.packing_items:
			se.append("items", {
				"s_warehouse": item.source_warehouse,
				"item_code": item.item_code,
				"qty": item.qty,
				"uom": item.uom,
				"serial_and_batch_bundle": item.serial_and_batch_bundle,
				"use_serial_batch_fields": 0 if item.serial_and_batch_bundle else 1,
			})

		# Add target items (incoming - from packed_fg_items)
		for item in self.packed_fg_items:
			se.append("items", {
				"t_warehouse": item.target_warehouse,
				"item_code": item.item_code,
				"qty": item.pack_qty,
				"is_finished_item": 1,
				"use_serial_batch_fields": 1,
			})

		se.insert()
		se.submit()

		# Link Stock Entry to Pack FG
		frappe.db.set_value("Pack FG", self.name, "stock_entry", se.name)
		frappe.msgprint(f"Stock Entry {se.name} created and submitted", alert=True)

	def cancel_stock_entry(self):
		"""Cancel linked Stock Entry on cancel"""
		if self.stock_entry:
			se = frappe.get_doc("Stock Entry", self.stock_entry)
			if se.docstatus == 1:
				se.cancel()
				frappe.msgprint(f"Stock Entry {se.name} cancelled", alert=True)



	
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

	data = get_packaging_material_data(item_code)

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