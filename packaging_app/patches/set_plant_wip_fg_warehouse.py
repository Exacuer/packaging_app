"""Backfill Plant Warehouse.wip_fg_warehouse.

Pack FG / Repack used to derive the Batch Selection warehouse from the company abbr
(``WIP FG - {abbr}``), ignoring the selected Plant. It now reads this field instead, so
existing Plant Warehouse rows need it populated once. Each plant already lists a
warehouse named like "Plant 1 WIP FG - PTPL"; pick that one.
"""

import frappe


def execute():
	if not frappe.db.has_column("Plant Warehouse", "wip_fg_warehouse"):
		return

	for plant in frappe.get_all(
		"Plant Warehouse", filters={"wip_fg_warehouse": ("in", ("", None))}, pluck="name"
	):
		warehouses = frappe.get_all(
			"Plant Warehouse Item",
			filters={"parent": plant, "parenttype": "Plant Warehouse"},
			pluck="warehouse",
			order_by="idx asc",
		)

		wip_fg = next(
			(w for w in warehouses if w and "wip fg" in w.lower().replace("-", " ")), None
		)
		if not wip_fg:
			frappe.log_error(
				title="Plant Warehouse: WIP FG warehouse not detected",
				message=(
					f"Plant {plant} has no warehouse whose name contains 'WIP FG'. "
					f"Set WIP FG Warehouse manually. Listed warehouses: {warehouses}"
				),
			)
			continue

		frappe.db.set_value("Plant Warehouse", plant, "wip_fg_warehouse", wip_fg)
