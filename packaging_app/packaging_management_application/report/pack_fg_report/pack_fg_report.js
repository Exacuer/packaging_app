// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.query_reports["Pack FG Report"] = {
	"filters": [
		{
			"fieldname": "from_date",
			"label": "From Date",
			"fieldtype": "Date"
		},
		{
			"fieldname": "to_date",
			"label": "To Date",
			"fieldtype": "Date"
		},
		{
			"fieldname": "company",
			"label": "Company",
			"fieldtype": "Link",
			"options": "Company"
		},
		{
			"fieldname": "batch_no",
			"label": "Source Batch",
			"fieldtype": "Data"
		},
		{
			"fieldname": "item_code",
			"label": "FG Item",
			"fieldtype": "Link",
			"options": "Item",
			"get_query": () => {
				return {
					filters: {
						custom_product_group: "Finished Goods"
					}
				};
			}
		},
		{
			"fieldname": "packed_item",
			"label": "Packed Item",
			"fieldtype": "Link",
			"options": "Item",
			"get_query": () => {
				return {
					filters: {
						item_group: "Packed Goods"
					}
				};
			}
		}
	]
};
