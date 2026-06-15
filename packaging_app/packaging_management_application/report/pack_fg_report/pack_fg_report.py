import frappe


def execute(filters=None):
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
            "label": "Pack FG",
            "fieldname": "pack_fg",
            "fieldtype": "Link",
            "options": "Pack FG",
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
            "label": "Source Item",
            "fieldname": "source_item",
            "fieldtype": "Link",
            "options": "Item",
            "width": 180,
        },
        {
            "label": "Source Batch",
            "fieldname": "source_batch",
            "fieldtype": "Data",
            "width": 250,
        },
        {
            "label": "Source Qty",
            "fieldname": "source_qty",
            "fieldtype": "Float",
            "width": 120,
        },
        {
            "label": "Packed Item",
            "fieldname": "packed_item",
            "fieldtype": "Link",
            "options": "Item",
            "width": 220,
        },
        {
            "label": "Pack Qty",
            "fieldname": "pack_qty",
            "fieldtype": "Float",
            "width": 120,
        },
        {
            "label": "Packed Qty",
            "fieldname": "packed_qty",
            "fieldtype": "Float",
            "width": 120,
        },
        {
            "label": "Packed Batch",
            "fieldname": "packed_batch",
            "fieldtype": "Data",
            "width": 250,
        },
    ]


def get_data(filters):
    conditions = []

    if filters.get("from_date"):
        conditions.append("pfg.posting_date >= %(from_date)s")

    if filters.get("to_date"):
        conditions.append("pfg.posting_date <= %(to_date)s")

    if filters.get("company"):
        conditions.append("pfg.company = %(company)s")

    if filters.get("batch_no"):
        conditions.append("pfg.batch_no = %(batch_no)s")

    if filters.get("item_code"):
        conditions.append("src.item_code = %(item_code)s")
    
    if filters.get("packed_item"):
        conditions.append("tgt.item_code = %(packed_item)s")

    conditions = " AND ".join(conditions)
    if conditions:
        conditions = f"WHERE {conditions}"

    return frappe.db.sql(
        f"""
        SELECT
            pfg.posting_date,
            pfg.name AS pack_fg,
            pfg.company,
            src.item_code AS source_item,
            pfg.batch_no AS source_batch,
            src.qty AS source_qty,
            tgt.item_code AS packed_item,
            tgt.batch AS packed_batch,
            tgt.pack_qty,
            tgt.qty AS packed_qty

        FROM `tabPack FG` pfg

        LEFT JOIN `tabPack FG Item Source` src
            ON src.parent = pfg.name

        LEFT JOIN `tabPack FG Item Target` tgt
            ON tgt.parent = pfg.name

        {conditions}

        ORDER BY
            pfg.posting_date DESC,
            pfg.name DESC
        """,
        filters,
        as_dict=True,
    )