// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.query_reports["Repack Report"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
		},
		{
			fieldname: "packed_item",
			label: __("Repack Item"),
			fieldtype: "Link",
			options: "Item",
			get_query: () => {
				return {
					filters: {
						item_group: "Packed Goods",
					},
				};
			},
		},
		{
			fieldname: "batch_no",
			label: __("Batch No"),
			fieldtype: "Data",
		},
		{
			fieldname: "item_code",
			label: __("Semi Product Item"),
			fieldtype: "Link",
			options: "Item",
			get_query: () => {
				return {
					filters: {
						custom_product_group: "Finished Goods",
					},
				};
			},
		}
	],
};
