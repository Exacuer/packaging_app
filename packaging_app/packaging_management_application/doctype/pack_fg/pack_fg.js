// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.ui.form.on("Pack FG", {
	setup(frm) {
		frm.ignore_doctypes_on_cancel_all = ["Serial and Batch Bundle"];
	},

	refresh(frm) {
		if(frm.doc.packing_items && frm.doc.packing_items.length > 0){
			frm.set_df_property('packing_items', 'cannot_add_rows', true);
		}
		if (!frm.doc.posting_date) {
			frm.set_value("posting_date", frappe.datetime.get_today());
		}
		if (!frm.doc.posting_time) {
			frm.set_value("posting_time", frappe.datetime.now_time());
		}
		frm.set_query("item_code", "packed_fg_items", function(doc, cdt, cdn) {

			let source_item = null;

			if (doc.packing_items?.length) {
				source_item = doc.packing_items[0].item_code;
			}

			return {
				query: "packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_item_packaging_material",
				filters: {
					item_code: source_item
				}
			};
		});
	},

	validate(frm) {
		// Validate packing_items qty = packed_fg_items qty
		let packing_qty = 0;
		let packed_qty = 0;

		(frm.doc.packing_items || []).forEach((item) => {
			packing_qty += flt(item.qty);
		});

		(frm.doc.packed_fg_items || []).forEach((item) => {
			packed_qty += flt(item.qty);
		});

		if (packing_qty !== packed_qty) {
			frappe.throw(__("Total Packing Items Qty ({0}) must equal Total Packed FG Items Qty ({1})", [packing_qty, packed_qty]));
		}
	},
});

frappe.ui.form.on("Pack FG Item Source", {
	packing_items_add(frm, cdt, cdn) {
		if(frm.doc.packing_items && frm.doc.packing_items.length > 0){
			frm.set_df_property('packing_items', 'cannot_add_rows', true);
		}
	},
	packing_items_remove(frm, cdt, cdn) {
		if(frm.doc.packing_items && frm.doc.packing_items.length === 0){
			frm.set_df_property('packing_items', 'cannot_add_rows', false);
		}
		frm.clear_table("packed_fg_items");
		frm.refresh_field("packed_fg_items");
	},
	add_serial_batch_bundle(frm, cdt, cdn) {
		let child = locals[cdt][cdn];

		if (!child.item_code) {
			frappe.throw(__("Please select an Item Code first"));
			return;
		}

		if (!child.source_warehouse) {
			frappe.throw(__("Please select a Source Warehouse first"));
			return;
		}

		if (!frm.doc.posting_date) {
			frm.doc.posting_date = frappe.datetime.get_today();
		}
		if (!frm.doc.posting_time) {
			frm.doc.posting_time = frappe.datetime.now_time();
		}

		frappe.db.get_value("Item", child.item_code, ["has_batch_no", "has_serial_no"]).then((r) => {
			if (r.message && (r.message.has_batch_no || r.message.has_serial_no)) {
				child.has_serial_no = r.message.has_serial_no;
				child.has_batch_no = r.message.has_batch_no;
				child.type_of_transaction = "Outward";
				child.s_warehouse = child.source_warehouse;
				child.warehouse = child.source_warehouse;
				child.parenttype = "Stock Entry";

				let selector = new erpnext.SerialBatchPackageSelector(frm, child, (result) => {
					if (result) {
						frappe.model.set_value(child.doctype, child.name, {
							serial_and_batch_bundle: result.name,
							qty: Math.abs(result.total_qty),
						});
						frappe.show_alert({message: __("Bundle {0} created", [result.name]), indicator: "green"});
					}
				});

				// Auto-fetch batches if qty is available
				if (child.qty > 0) {
					setTimeout(() => {
						selector.get_auto_data();
					}, 500);
				}
			} else {
				frappe.msgprint(__("Item {0} does not have Serial No or Batch No enabled", [child.item_code]));
			}
		});
	},

	item_code(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.serial_and_batch_bundle) {
			frappe.model.set_value(cdt, cdn, "serial_and_batch_bundle", "");
		}
// Discard for different requirements

		// frappe.db.get_doc("Item", row.item_code).then((itemDoc) => {
		// 	console.log(
		// 		"Fetched item details for",
		// 		row.item_code,
		// 		itemDoc.custom_packing_material_details
		// 	);

		// 	if (itemDoc.custom_packing_material_details?.length) {

		// 		// Optional: clear existing rows first
		// 		frm.clear_table("packed_fg_items");

		// 		itemDoc.custom_packing_material_details.forEach((packingDetail) => {
		// 			console.log("Packing Detail:", packingDetail);

		// 			let packing_row = frm.add_child("packed_fg_items");
		// 			packing_row.item_code = packingDetail.item;
		// 			packing_row.filling_capacity = packingDetail.filling_capacity;

		// 			// Add other fields if required
		// 			// packing_row.uom = packingDetail.uom;
		// 		});

		// 		frm.refresh_field("packed_fg_items");
		// 	}
		// });
	},

	source_warehouse(frm, cdt, cdn) {
		let child = locals[cdt][cdn];
		if (child.serial_and_batch_bundle) {
			frappe.model.set_value(cdt, cdn, "serial_and_batch_bundle", "");
		}
		for(let i = 0; i < frm.doc.packed_fg_items.length; i++){
			frm.doc.packed_fg_items[i].target_warehouse = child.source_warehouse;
		}
		frm.refresh_field("packed_fg_items");
	},
});

frappe.ui.form.on("Pack FG Item Target", {
	filling_capacity(frm, cdt, cdn) {
		calculate_packed_qty(frm, cdt, cdn);
	},

	pack_qty(frm, cdt, cdn) {
		calculate_packed_qty(frm, cdt, cdn);
	},
	packed_fg_items_add(frm, cdt, cdn) {
		let child = locals[cdt][cdn];
		if(frm.doc.packing_items && frm.doc.packing_items.length > 0){
			child.target_warehouse = frm.doc.packing_items[0].source_warehouse;
		}
	}
});

function calculate_packed_qty(frm, cdt, cdn) {
	let child = locals[cdt][cdn];
	let qty = flt(child.filling_capacity) * flt(child.pack_qty);
	frappe.model.set_value(cdt, cdn, "qty", qty);
}
