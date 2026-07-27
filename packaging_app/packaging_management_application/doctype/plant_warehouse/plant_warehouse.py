# Copyright (c) 2026, Vivek Choudhary and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class PlantWarehouse(Document):
	def validate(self):
		self.validate_wip_fg_warehouse()

	def validate_wip_fg_warehouse(self):
		"""WIP FG Warehouse has to be one of the plant's own warehouses -- anything else
		would be offered as the default Source/Target Warehouse on Pack FG and Repack and
		then rejected by the plant-restricted warehouse picker."""
		if not self.wip_fg_warehouse:
			return

		listed = [row.warehouse for row in self.warehouses if row.warehouse]
		if self.wip_fg_warehouse not in listed:
			frappe.throw(
				_("{0} is not listed in the Warehouses table below. Add it there first.").format(
					frappe.bold(self.wip_fg_warehouse)
				),
				title=_("Invalid WIP FG Warehouse"),
			)
