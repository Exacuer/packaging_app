import frappe


def execute(filters=None):
	filters = frappe._dict(filters or {})
	columns = get_columns()
	data = get_data(filters)

	return columns, data


def get_columns():
	return [
		{
			"label": "Posting Date",
			"fieldname": "posting_date",
			"fieldtype": "Date",
			"width": 110,
		},
		{
			"label": "Repack",
			"fieldname": "repack",
			"fieldtype": "Link",
			"options": "Repack",
			"width": 140,
		},
		{
			"label": "Company",
			"fieldname": "company",
			"fieldtype": "Link",
			"options": "Company",
			"width": 180,
		},
		{
			"label": "Repack Item",
			"fieldname": "packed_item",
			"fieldtype": "Link",
			"options": "Item",
			"width": 220,
		},
		{
			"label": "Batch No",
			"fieldname": "packed_batch",
			"fieldtype": "Data",
			"width": 250,
		},
		{
			"label": "Repack Qty",
			"fieldname": "repack_qty",
			"fieldtype": "Float",
			"width": 120,
		},
		{
			"label": "Semi Product Item",
			"fieldname": "semi_product_item",
			"fieldtype": "Link",
			"options": "Item",
			"width": 180,
		},
		{
			"label": "Pack Qty",
			"fieldname": "pack_qty",
			"fieldtype": "Float",
			"width": 120,
		},
		{
			"label": "Semi Product Qty",
			"fieldname": "semi_product_qty",
			"fieldtype": "Float",
			"width": 120,
		},
		{
			"label": "Semi Product Batch",
			"fieldname": "semi_product_batch",
			"fieldtype": "Data",
			"width": 250,
		},
	]


def get_data(filters):
	conditions = []

	if filters.get("from_date"):
		conditions.append("r.posting_date >= %(from_date)s")

	if filters.get("to_date"):
		conditions.append("r.posting_date <= %(to_date)s")

	if filters.get("company"):
		conditions.append("r.company = %(company)s")

	if filters.get("batch_no"):
		conditions.append("r.batch_no = %(batch_no)s")

	if filters.get("item_code"):
		conditions.append("semi.item_code = %(item_code)s")

	if filters.get("packed_item"):
		conditions.append("repack_row.item_code = %(packed_item)s")

	conditions = " AND ".join(conditions)
	if conditions:
		conditions = f"WHERE {conditions}"

	return frappe.db.sql(
		f"""
		SELECT
			r.posting_date,
			r.name AS repack,
			r.company,
			repack_row.item_code AS packed_item,
			r.batch_no AS packed_batch,
			repack_row.qty AS repack_qty,
			semi.item_code AS semi_product_item,
			semi.pack_qty,
			semi.qty AS semi_product_qty,
			semi.batch AS semi_product_batch
		FROM `tabRepack` r
		LEFT JOIN `tabRepack FG Item Code` repack_row
			ON repack_row.parent = r.name
		LEFT JOIN `tabReack FG Item Target` semi
			ON semi.parent = r.name
		{conditions}
		ORDER BY
			r.posting_date DESC,
			r.name DESC,
			repack_row.idx ASC
		""",
		filters,
		as_dict=True,
	)
