// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.ui.form.on("Plant Warehouse", {
	refresh(frm) {
		set_wip_fg_warehouse_query(frm);
	},

	warehouses_on_form_rendered(frm) {
		set_wip_fg_warehouse_query(frm);
	},
});

frappe.ui.form.on("Plant Warehouse Item", {
	warehouses_add(frm) {
		set_wip_fg_warehouse_query(frm);
	},
	warehouse(frm) {
		set_wip_fg_warehouse_query(frm);
	},
	warehouses_remove(frm) {
		set_wip_fg_warehouse_query(frm);
	},
});

// Only the plant's own warehouses may be picked as its WIP FG Warehouse -- the server
// enforces this too, the query just stops the user hitting that error.
function set_wip_fg_warehouse_query(frm) {
	frm.set_query("wip_fg_warehouse", () => {
		const listed = (frm.doc.warehouses || []).map((row) => row.warehouse).filter(Boolean);
		return {
			filters: [["Warehouse", "name", "in", listed.length ? listed : ["___none___"]]],
		};
	});
}
