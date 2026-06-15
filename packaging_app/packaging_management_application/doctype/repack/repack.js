// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.ui.form.on("Repack", {
	setup(frm) {
		frm.ignore_doctypes_on_cancel_all = ["Serial and Batch Bundle"];

		frm.set_query("item_code", "repack_items", function (doc, cdt, cdn) {
			const parent_doc = doc || frm.doc;
			const anchor_row = get_anchor_repack_row(parent_doc, cdn);
			const filters = {
				item_group: "Packed Goods",
			};

			if (anchor_row && frm._anchor_finished_item) {
				filters.custom_finished_item = frm._anchor_finished_item;
			}

			const exclude_items = get_used_repack_items(parent_doc, cdn);
			if (exclude_items.length) {
				filters.name = ["not in", exclude_items];
			}

			return { filters };
		});

		frm.set_query("item_code", "packed_fg_items", function () {
			const finished_item = frm._anchor_finished_item;
			return {
				filters: {
					name: ["in", finished_item ? [finished_item] : ["__none__"]],
				},
			};
		});
	},

	refresh(frm) {
		update_repack_items_grid_limits(frm);
		update_semi_product_grid_limits(frm);
		toggle_repack_workflow_ui(frm);

		if (!is_repack_editable(frm)) {
			setup_semi_product_header(frm);
			return;
		}

		if (!frm.doc.posting_date) {
			frm.set_value("posting_date", frappe.datetime.get_today());
		}
		if (!frm.doc.posting_time) {
			frm.set_value("posting_time", frappe.datetime.now_time());
		}
		frm.set_query("batch", "packed_fg_items", function (doc, cdt, cdn) {
			const row = locals[cdt]?.[cdn];
			return {
				filters: {
					item: row?.item_code || "",
				},
			};
		});
		setup_batch_section_header(frm);
		setup_semi_product_header(frm);
		set_default_wip_fg_warehouse(frm).then(() => {
			apply_default_target_warehouse(frm);
			const after_sync = () => {
				render_item_batch_ui(frm);
				update_repack_form_actions(frm);
			};

			if (should_skip_semi_product_sync_on_refresh(frm)) {
				refresh_anchor_finished_item(frm).then(after_sync);
				return;
			}

			sync_semi_product_from_repack_items(frm).then(after_sync);
		});
	},

	company(frm) {
		set_default_wip_fg_warehouse(frm).then(() => {
			apply_default_target_warehouse(frm);
			sync_semi_product_from_repack_items(frm).then(() => {
				render_item_batch_ui(frm);
				update_repack_form_actions(frm);
			});
		});
	},

	posting_date(frm) {
		render_item_batch_ui(frm);
	},

	posting_time(frm) {
		render_item_batch_ui(frm);
	},

	validate(frm) {
		if (frm.doc.repack_items?.length && !are_batches_applied(frm)) {
			frappe.throw(__("Please click Apply Batches before save."));
		}

		sync_repack_qty_from_batch_ui(frm);

		const { pick_qty: pick_qty_from_ui, total_qty: liters_from_ui } =
			get_batch_pick_totals_from_ui(frm);
		if (pick_qty_from_ui > 0) {
			sync_semi_product_from_batch_ui(frm, pick_qty_from_ui, liters_from_ui);
		}

		const repack_qty = (frm.doc.repack_items || []).reduce(
			(sum, item) => sum + flt(item.qty),
			0
		);
		const semi_product_pack_qty = (frm.doc.packed_fg_items || []).reduce(
			(sum, item) => sum + flt(item.pack_qty),
			0
		);
		const precision = get_float_precision();

		let effective_pack_qty = pick_qty_from_ui > 0 ? pick_qty_from_ui : repack_qty;
		if (
			!pick_qty_from_ui &&
			are_batches_applied(frm) &&
			flt(semi_product_pack_qty, precision) > 0
		) {
			effective_pack_qty = semi_product_pack_qty;
		}

		if (flt(effective_pack_qty, precision) !== flt(semi_product_pack_qty, precision)) {
			throw_qty_mismatch_error(frm, effective_pack_qty, semi_product_pack_qty);
		}
	},
});

frappe.ui.form.on("Repack FG Item Code", {
	repack_items_add(frm) {
		update_repack_items_grid_limits(frm);
		sync_semi_product_from_repack_items(frm);
		render_item_batch_ui(frm);
	},

	repack_items_remove(frm) {
		update_repack_items_grid_limits(frm);
		if (!(frm.doc.repack_items || []).length) {
			frm._anchor_finished_item = null;
			frm.clear_table("packed_fg_items");
			frm.refresh_field("packed_fg_items");
			frm.set_value("batch_no", "");
			update_semi_product_grid_limits(frm);
		} else {
			sync_semi_product_from_repack_items(frm);
		}
		render_item_batch_ui(frm);
	},

	item_code(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.serial_and_batch_bundle) {
			frappe.model.set_value(cdt, cdn, {
				serial_and_batch_bundle: "",
				qty: 0,
			});
			frm.set_value("batch_no", "");
		}

		if (row.item_code) {
			const first_row = (frm.doc.repack_items || []).find((r) => r.item_code);
			if (first_row?.name === cdn) {
				frappe.db
					.get_value("Item", row.item_code, "custom_finished_item")
					.then((r) => {
						frm._anchor_finished_item = r.message?.custom_finished_item || null;
					});
			}
		}

		sync_semi_product_from_repack_items(frm);
		render_item_batch_ui(frm);
	},

	source_warehouse(frm, cdt, cdn) {
		let child = locals[cdt][cdn];
		if (child.serial_and_batch_bundle) {
			frappe.model.set_value(cdt, cdn, {
				serial_and_batch_bundle: "",
				qty: 0,
			});
			frm.set_value("batch_no", "");
		}
		render_item_batch_ui(frm);
	},
});

frappe.ui.form.on("Reack FG Item Target", {
	pack_qty(frm) {
		update_qty_summary(frm);
	},

	filling_capacity(frm) {
		update_qty_summary(frm);
	},

	qty(frm) {
		update_qty_summary(frm);
	},

	packed_fg_items_remove(frm) {
		update_semi_product_grid_limits(frm);
		update_qty_summary(frm);
		setup_apply_batches_button(frm);
	},

	packed_fg_items_add(frm, cdt, cdn) {
		update_semi_product_grid_limits(frm);
		let child = locals[cdt][cdn];
		if (frm._default_wip_fg_warehouse) {
			child.target_warehouse = frm._default_wip_fg_warehouse;
		}
		set_semi_product_row_batch_if_enabled(frm, cdt, cdn);
		setup_apply_batches_button(frm);
	},

	item_code(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		if (!row.item_code) {
			return;
		}

		set_semi_product_row_batch_if_enabled(frm, cdt, cdn);
		sync_semi_product_filling_capacity(frm, cdt, cdn);
	},

});

function get_float_precision() {
	return frappe.defaults.get_default("float_precision") || 3;
}

function get_repack_rows(frm) {
	return (frm.doc.repack_items || []).filter((row) => row.item_code);
}

function field_values_equal(current, next, fieldname) {
	const float_fields = new Set(["qty", "pack_qty", "filling_capacity", "density"]);
	if (float_fields.has(fieldname)) {
		return flt(current, get_float_precision()) === flt(next, get_float_precision());
	}
	return (current || "") === (next || "");
}

function set_model_value_if_changed(doctype, name, updates) {
	const row = locals[doctype]?.[name];
	if (!row) {
		return Promise.resolve();
	}

	const changed = {};
	for (const [field, value] of Object.entries(updates)) {
		if (!field_values_equal(row[field], value, field)) {
			changed[field] = value;
		}
	}

	if (!Object.keys(changed).length) {
		return Promise.resolve();
	}

	return frappe.model.set_value(doctype, name, changed);
}

function should_skip_semi_product_sync_on_refresh(frm) {
	if (!frm.doc.name || frm.is_new()) {
		return false;
	}

	const target_row = (frm.doc.packed_fg_items || [])[0];
	return are_batches_applied(frm) && !!target_row?.item_code && !!target_row?.pack_qty;
}

function refresh_anchor_finished_item(frm) {
	const first_row = get_repack_rows(frm)[0];
	if (!first_row?.item_code) {
		frm._anchor_finished_item = null;
		return Promise.resolve();
	}

	if (frm._anchor_finished_item) {
		return Promise.resolve();
	}

	return frappe.db
		.get_value("Item", first_row.item_code, "custom_finished_item")
		.then((r) => {
			frm._anchor_finished_item = r.message?.custom_finished_item || null;
		});
}

function get_repack_row(frm) {
	return get_repack_rows(frm)[0];
}

function update_repack_items_grid_limits(frm) {
	frm.set_df_property("repack_items", "cannot_add_rows", false);
}

function update_semi_product_grid_limits(frm) {
	const has_row = (frm.doc.packed_fg_items || []).length > 0;
	frm.set_df_property("packed_fg_items", "cannot_add_rows", has_row);
}

function get_anchor_repack_row(parent_doc, current_cdn) {
	const rows = (parent_doc.repack_items || []).filter((row) => row.item_code);
	const first_row = rows[0];
	if (!first_row || first_row.name === current_cdn) {
		return null;
	}
	return first_row;
}

function get_used_repack_items(parent_doc, current_cdn) {
	return (parent_doc.repack_items || [])
		.filter((row) => row.item_code && row.name !== current_cdn)
		.map((row) => row.item_code);
}

function sync_semi_product_filling_capacity(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.item_code) {
		return;
	}

	frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.repack.repack.get_repack_semi_product_info",
		args: {
			repack_items: frm.doc.repack_items || [],
		},
		callback(r) {
			const info = r.message || {};
			if (info.filling_capacity != null) {
				set_model_value_if_changed(cdt, cdn, {
					filling_capacity: flt(info.filling_capacity),
				});
			}
		},
	});
}

function sync_semi_product_from_repack_items(frm) {
	const repack_rows = (frm.doc.repack_items || []).filter((row) => row.item_code);
	if (!repack_rows.length) {
		frm._anchor_finished_item = null;
		update_semi_product_grid_limits(frm);
		return Promise.resolve();
	}

	return frappe
		.call({
			method:
				"packaging_app.packaging_management_application.doctype.repack.repack.get_repack_semi_product_info",
			args: { repack_items: repack_rows },
		})
		.then((r) => {
			const info = r.message || {};

			for (const row of frm.doc.repack_items || []) {
				if (!row.item_code) {
					continue;
				}
				const fg = (info.item_finished_map || {})[row.item_code];
				if (fg) {
					row._finished_item = fg;
				}
				row._requires_batch = (info.item_batch_map || {})[row.item_code];
			}

			if ((info.finished_items || []).length > 1) {
				frappe.msgprint({
					message: __("All Repack Items must have the same Finished Item."),
					indicator: "orange",
				});
				return;
			}

			if (!info.finished_item) {
				frm._anchor_finished_item = null;
				frappe.msgprint({
					message: __(
						"Finished Item is not set on the selected packed item(s). Please set Finished Item on the Item master."
					),
					indicator: "orange",
				});
				return;
			}

			frm._anchor_finished_item = info.finished_item;

			let target_row = (frm.doc.packed_fg_items || [])[0];
			if (!target_row) {
				target_row = frm.add_child("packed_fg_items");
			}

			const updates = {
				item_code: info.finished_item,
			};
			if (info.filling_capacity != null) {
				updates.filling_capacity = flt(info.filling_capacity);
			} else if (info.item_filling_capacity_map && repack_rows[0]?.item_code) {
				updates.filling_capacity = flt(
					info.item_filling_capacity_map[repack_rows[0].item_code]
				);
			}
			if (!target_row.target_warehouse && frm._default_wip_fg_warehouse) {
				updates.target_warehouse = frm._default_wip_fg_warehouse;
			}

			set_model_value_if_changed(target_row.doctype, target_row.name, updates).then(() => {
				frm.refresh_field("packed_fg_items");
				update_semi_product_grid_limits(frm);
				set_semi_product_row_batch_if_enabled(frm, target_row.doctype, target_row.name);
			});
		});
}

function are_batches_applied(frm) {
	const repack_rows = get_repack_rows(frm);
	if (!repack_rows.length || !frm.doc.batch_no) {
		return false;
	}

	return repack_rows.every((row) => {
		if (row._requires_batch === false) {
			return true;
		}
		return !!row.serial_and_batch_bundle;
	});
}

function update_repack_form_actions(frm) {
	if (frm.doc.docstatus !== 0) {
		return;
	}

	const show_save = are_batches_applied(frm);
	if (frm.page.btn_primary) {
		frm.page.btn_primary.toggle(show_save);
	}
}

const REPACK_SECTION_DIVIDER = "border-top: 1px solid var(--border-color, #d1d8dd); margin-top: 12px; padding-top: 12px;";

function is_repack_editable(frm) {
	return frm.doc.docstatus === 0;
}

function toggle_repack_workflow_ui(frm) {
	const show = is_repack_editable(frm);
	for (const fieldname of ["item_batch_ui", "batch_picked_summary"]) {
		const field = frm.get_field(fieldname);
		field?.$wrapper.closest(".frappe-control").toggle(show);
	}
}

function setup_batch_section_header(frm) {
	const field = frm.get_field("item_batch_ui");
	if (field) {
		field.$wrapper.closest(".frappe-control").find(".control-label").hide();
	}
}

function setup_semi_product_header(frm) {
	const packed_field = frm.get_field("packed_fg_items");
	if (packed_field) {
		packed_field.$wrapper.find(".control-label").hide();
	}
	const summary_field = frm.get_field("batch_picked_summary");
	if (summary_field) {
		summary_field.$wrapper.closest(".frappe-control").find(".control-label").hide();
	}
	toggle_repack_workflow_ui(frm);
	if (!is_repack_editable(frm)) {
		return;
	}
	update_qty_summary(frm);
	setup_apply_batches_button(frm);
}

function setup_apply_batches_button(frm) {
	const packed_field = frm.get_field("packed_fg_items");
	if (!packed_field?.grid) {
		return;
	}

	const is_readonly = frm.doc.docstatus !== 0;
	const $grid_buttons = $(packed_field.grid.wrapper).find(".grid-footer .grid-buttons");
	if (!$grid_buttons.length) {
		return;
	}

	$grid_buttons.css({
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: "8px",
		width: "100%",
	});

	let $btn = $grid_buttons.find(".btn-apply-batches");
	if (!$btn.length) {
		$btn = $(`<button type="button" class="btn btn-primary btn-sm btn-apply-batches" style="margin-left: auto;">${__(
			"Apply Batches"
		)}</button>`);
		$grid_buttons.append($btn);
		$btn.on("click", () => {
			const batch_ui = frm.get_field("item_batch_ui");
			if (batch_ui) {
				apply_batch_selection(frm, batch_ui.$wrapper);
			}
		});
	}

	$btn.toggle(!is_readonly);
}

function render_status_chip(value, has_value) {
	const text = value || __("Not set");
	const color = has_value ? "#1b7a2b" : "#c62828";
	const bg = has_value ? "#e8f5e9" : "#ffebee";

	return `<span style="
		display: inline-block;
		padding: 3px 10px;
		border-radius: 12px;
		font-size: 12px;
		font-weight: 600;
		color: ${color};
		background: ${bg};
	">${frappe.utils.escape_html(text)}</span>`;
}

function render_section_header(title, filters_html) {
	return `
		<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
			<span style="font-size: 14px; font-weight: 600;">${title}</span>
			${filters_html || ""}
		</div>
	`;
}

function render_batch_item_label(batch) {
	const code = batch.item_code || "";
	const name = batch.item_name || "";
	if (!name || name === code) {
		return frappe.utils.escape_html(name || code);
	}
	return `${frappe.utils.escape_html(code)} - ${frappe.utils.escape_html(name)}`;
}

function render_batch_filter_banner(repack_rows, company, default_warehouse) {
	const first_row = repack_rows?.[0];
	const warehouse = first_row?.source_warehouse || default_warehouse;
	const item_codes = (repack_rows || []).map((row) => row.item_code).filter(Boolean);
	const item_label = item_codes.length
		? item_codes.length === 1
			? item_codes[0]
			: __("{0} items", [item_codes.length])
		: __("Packed Goods");
	const has_item = item_codes.length > 0;

	const item_html = render_status_chip(item_label, has_item || true);
	const warehouse_html = render_status_chip(warehouse || __("Any"), !!warehouse);

	return render_section_header(
		__("Batch Selection"),
		`<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px;">
			<span class="text-muted">${__("Company")}:</span> ${render_status_chip(company, !!company)}
			<span class="text-muted">${has_item ? __("Item") : __("Item Group")}:</span> ${item_html}
			<span class="text-muted">${__("Warehouse")}:</span> ${warehouse_html}
		</div>`
	);
}

function get_pick_qty_from_inputs(frm) {
	const { pick_qty } = get_batch_pick_totals_from_ui(frm);
	return pick_qty;
}

function get_batch_pick_totals_from_ui(frm) {
	const field = frm.get_field("item_batch_ui");
	if (!field) {
		return { pick_qty: 0, total_qty: 0 };
	}

	let pick_qty = 0;
	let total_qty = 0;

	field.$wrapper.find("tbody tr").each((_, tr) => {
		const $tr = $(tr);
		const $input = $tr.find(".batch-pick-qty");
		const row_pick_qty = flt($input.val());
		const filling_capacity = flt($input.data("filling-capacity"));
		pick_qty += row_pick_qty;
		total_qty += flt(row_pick_qty * filling_capacity);
	});

	return { pick_qty, total_qty };
}

function sync_repack_qty_from_batch_ui(frm) {
	const field = frm.get_field("item_batch_ui");
	if (!field?.$wrapper) {
		return;
	}

	let picks_by_key;
	try {
		picks_by_key = collect_batch_picks_by_repack_row(field.$wrapper, frm);
	} catch {
		return;
	}

	const precision = get_float_precision();
	for (const { repack_row, total_picked } of Object.values(picks_by_key)) {
		if (!repack_row || !flt(total_picked)) {
			continue;
		}
		const qty = flt(total_picked, precision);
		if (flt(repack_row.qty, precision) !== qty) {
			frappe.model.set_value(repack_row.doctype, repack_row.name, "qty", qty);
		}
	}
}

function update_batch_row_total_qty($tr) {
	const $input = $tr.find(".batch-pick-qty");
	const row_total_qty = flt($input.val()) * flt($input.data("filling-capacity"));
	$tr.find(".batch-total-qty").text(format_number(row_total_qty));
	return row_total_qty;
}

function sync_semi_product_from_batch_ui(frm, pick_qty, total_qty) {
	const target_row = (frm.doc.packed_fg_items || [])[0];
	if (!target_row) {
		return Promise.resolve();
	}

	const precision = frappe.defaults.get_default("float_precision") || 3;
	const updates = {};

	if (pick_qty) {
		updates.pack_qty = flt(pick_qty, precision);
	}
	if (total_qty || pick_qty) {
		updates.qty = flt(total_qty, precision);
	}

	if (!Object.keys(updates).length) {
		return Promise.resolve();
	}

	return set_model_value_if_changed(target_row.doctype, target_row.name, updates);
}

function get_current_picks_from_ui(frm) {
	const field = frm.get_field("item_batch_ui");
	const repack_row = get_repack_row(frm);
	const picks = [];

	if (field) {
		field.$wrapper.find("tbody tr").each((_, tr) => {
			const $tr = $(tr);
			const $input = $tr.find(".batch-pick-qty");
			const qty = flt($input.val());

			if (qty > 0) {
				picks.push({
					batch_no: $tr.data("batch-no"),
					qty,
					warehouse: $input.data("warehouse") || repack_row?.source_warehouse,
				});
			}
		});
	}

	return picks;
}

function throw_qty_mismatch_error(frm, pick_qty, semi_product_pack_qty) {
	const precision = frappe.defaults.get_default("float_precision") || 3;
	const repack_row = get_repack_row(frm);
	let message = __(
		"Total Pick Qty ({0}) must equal Total Semi Product Pack Qty ({1}) across all semi product rows",
		[flt(pick_qty, precision), flt(semi_product_pack_qty, precision)]
	);

	if (frm.doc.company && repack_row?.item_code) {
		frappe.call({
			method:
				"packaging_app.packaging_management_application.doctype.repack.repack.get_qty_balance_suggestions_api",
			args: {
				company: frm.doc.company,
				item_code: repack_row.item_code,
				source_warehouse: repack_row.source_warehouse,
				pick_qty: flt(pick_qty, precision),
				semi_product_pack_qty: flt(semi_product_pack_qty, precision),
				current_picks: get_current_picks_from_ui(frm),
				serial_and_batch_bundle: repack_row.serial_and_batch_bundle,
				posting_date: frm.doc.posting_date,
				posting_time: frm.doc.posting_time,
			},
			async: false,
			callback(r) {
				if (r.message?.message) {
					message = r.message.message;
				}
			},
		});
	}

	frappe.throw(message);
}

function render_qty_suggestions_html(suggestions_data) {
	if (!suggestions_data?.suggestions?.length) {
		return "";
	}

	const lines = (suggestions_data.suggestions || [])
		.map((suggestion) => {
			if (suggestion.action === "add") {
				return __(
					"Add {0} from Batch {1} at {2}",
					[format_number(suggestion.qty), suggestion.batch_no, suggestion.warehouse]
				);
			}
			return __(
				"Remove {0} from Batch {1} at {2}",
				[format_number(suggestion.qty), suggestion.batch_no, suggestion.warehouse]
			);
		})
		.map(
			(line) =>
				`<li style="margin-bottom: 4px;">${frappe.utils.escape_html(line)}</li>`
		)
		.join("");

	let html = `<ul style="margin: 8px 0 0 18px; padding: 0; font-size: 12px;">${lines}</ul>`;

	if (suggestions_data.unfulfilled) {
		html += `<div style="margin-top: 6px; font-size: 12px; color: #c62828;">
			${frappe.utils.escape_html(
				__(
					"Could not fully cover {0} using available batches. Check stock in other warehouses or adjust Pack Qty.",
					[format_number(suggestions_data.unfulfilled)]
				)
			)}
		</div>`;
	}

	if (suggestions_data.pack_alternative) {
		html += `<div style="margin-top: 6px; font-size: 12px; color: var(--text-muted, #6c757d);">
			${frappe.utils.escape_html(suggestions_data.pack_alternative)}
		</div>`;
	}

	return html;
}

function fetch_qty_suggestions(frm, pick_qty, semi_product_pack_qty, callback) {
	const precision = frappe.defaults.get_default("float_precision") || 3;
	const repack_row = get_repack_row(frm);

	if (
		!frm.doc.company ||
		!repack_row?.item_code ||
		flt(pick_qty, precision) === flt(semi_product_pack_qty, precision)
	) {
		callback(null);
		return;
	}

	frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.repack.repack.get_qty_balance_suggestions_api",
		args: {
			company: frm.doc.company,
			item_code: repack_row.item_code,
			source_warehouse: repack_row.source_warehouse,
			pick_qty: flt(pick_qty, precision),
			semi_product_pack_qty: flt(semi_product_pack_qty, precision),
			current_picks: get_current_picks_from_ui(frm),
			serial_and_batch_bundle: repack_row.serial_and_batch_bundle,
			posting_date: frm.doc.posting_date,
			posting_time: frm.doc.posting_time,
		},
		callback(r) {
			callback(r.message || null);
		},
	});
}

function get_pick_qty(frm, override_pick) {
	if (override_pick != null) {
		return flt(override_pick);
	}
	const from_inputs = get_pick_qty_from_inputs(frm);
	if (from_inputs) {
		return from_inputs;
	}
	return flt(get_repack_row(frm)?.qty);
}

function get_semi_product_totals(frm) {
	let pack_qty = 0;
	let semi_product_qty = 0;

	for (const row of frm.doc.packed_fg_items || []) {
		pack_qty += flt(row.pack_qty);
		semi_product_qty += flt(row.qty);
	}

	return { pack_qty, semi_product_qty };
}

const REPACK_BATCH_SEPARATOR_PATTERN = /[/.\\_~|:]+/g;

function normalize_repack_semi_product_batch_id(source_batch) {
	const batch = String(source_batch || "").trim();
	if (!batch) {
		return "";
	}

	return batch
		.replace(REPACK_BATCH_SEPARATOR_PATTERN, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function resolve_semi_product_batch_for_row(frm, source_batch_no, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row?.item_code || !source_batch_no) {
		return Promise.resolve();
	}

	return frappe
		.call({
			method:
				"packaging_app.packaging_management_application.doctype.repack.repack.get_repack_semi_product_batch_id_api",
			args: {
				source_batch_no,
				item_code: row.item_code,
				current_batch: row.batch,
			},
		})
		.then((r) => {
			if (!r.message) {
				return;
			}

			return frappe.db
				.get_value("Batch", source_batch_no, "custom_density")
				.then((batch_r) => {
					return set_model_value_if_changed(cdt, cdn, {
						batch: r.message,
						density: flt(batch_r.message?.custom_density),
					});
				});
		});
}

function set_semi_product_row_batch_if_enabled(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.item_code || !frm.doc.batch_no) {
		return;
	}

	if (row.batch) {
		return;
	}

	frappe.db.get_value("Item", row.item_code, "has_batch_no", (r) => {
		if (r.message?.has_batch_no) {
			resolve_semi_product_batch_for_row(frm, frm.doc.batch_no, cdt, cdn);
		} else {
			set_model_value_if_changed(cdt, cdn, {
				batch: "",
				density: 0,
			});
		}
	});
}

function preview_semi_product_batch_from_selection(frm, source_batch_no) {
	const target_row = (frm.doc.packed_fg_items || [])[0];
	if (!target_row?.item_code || !source_batch_no) {
		return;
	}

	resolve_semi_product_batch_for_row(
		frm,
		source_batch_no,
		target_row.doctype,
		target_row.name
	);
}

function link_semi_product_batches(frm, source_batch_no) {
	return frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.repack.repack.create_and_link_semi_product_batches",
		args: {
			source_batch_no,
			target_items: frm.doc.packed_fg_items || [],
			repack_name: frm.doc.name,
		},
	}).then((r) => {
		for (const row of r.message?.rows || []) {
			set_model_value_if_changed("Reack FG Item Target", row.name, {
				batch: row.batch || "",
				density: row.density != null ? flt(row.density) : 0,
			});
		}
		frm.refresh_field("packed_fg_items");
		return r.message;
	});
}

function render_qty_stat(label, value, accent) {
	const tint = `${accent}14`;
	return `
		<div class="pack-fg-stat" style="
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 4px 12px 4px 8px;
			border-radius: 20px;
			background: ${tint};
			border: 1px solid ${accent}33;
			line-height: 1;
		">
			<span style="
				width: 6px;
				height: 6px;
				border-radius: 50%;
				background: ${accent};
				flex-shrink: 0;
			"></span>
			<span style="
				font-size: 10px;
				font-weight: 600;
				text-transform: uppercase;
				letter-spacing: 0.05em;
				color: var(--text-muted, #6c7680);
				white-space: nowrap;
			">${label}</span>
			<span style="
				font-size: 14px;
				font-weight: 700;
				color: ${accent};
				font-variant-numeric: tabular-nums;
				white-space: nowrap;
			">${format_number(flt(value))}</span>
		</div>
	`;
}

function update_qty_summary(frm, override_pick) {
	const field = frm.get_field("batch_picked_summary");
	if (!field) {
		return;
	}

	if (!is_repack_editable(frm)) {
		field.$wrapper.empty();
		return;
	}

	const pick_qty = get_pick_qty(frm, override_pick);
	const { pack_qty, semi_product_qty } = get_semi_product_totals(frm);
	const precision = frappe.defaults.get_default("float_precision") || 3;
	const is_balanced =
		!pick_qty ||
		!semi_product_qty ||
		flt(pick_qty, precision) === flt(pack_qty, precision);
	const balance_color = is_balanced ? "var(--green-500, #28a745)" : "var(--orange-500, #e67e22)";
	const balance_icon = is_balanced ? "✓" : "!";
	const balance_text = is_balanced
		? __("Pick and Pack qty match")
		: __("Pick and Pack qty do not match");
	const diff = flt(pack_qty, precision) - flt(pick_qty, precision);
	const mismatch_hint = !is_balanced
		? diff > 0
			? __("Short by {0} — add pick qty from:", [format_number(diff)])
			: __("Excess of {0} — reduce pick qty from:", [format_number(Math.abs(diff))])
		: "";

	const render_summary = (suggestions_html = "") => {
		field.$wrapper.html(`
			<div class="repack-qty-summary" style="${REPACK_SECTION_DIVIDER} padding-bottom: 8px;">
				<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
					<span style="font-size: 13px; font-weight: 600; color: var(--text-color, #333);">${__("Semi Product Items")}</span>
					<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">
						${render_qty_stat(__("Pick Qty"), pick_qty, "#2490ef")}
						${render_qty_stat(__("Pack Qty"), pack_qty, "#743ee2")}
						${render_qty_stat(__("Semi Product Qty"), semi_product_qty, "#28a745")}
						<span title="${balance_text}" style="
							display: inline-flex;
							align-items: center;
							justify-content: center;
							width: 20px;
							height: 20px;
							border-radius: 50%;
							background: ${balance_color};
							color: #fff;
							font-weight: 700;
							font-size: 11px;
							flex-shrink: 0;
							margin-left: 2px;
						">${balance_icon}</span>
					</div>
				</div>
				${
					!is_balanced
						? `<div style="margin-top: 10px; padding: 10px 12px; border: 1px solid #f0ad4e; border-radius: 6px; background: #fff8e6;">
							<div style="font-size: 12px; font-weight: 600; color: #8a6d3b; margin-bottom: 4px;">
								${frappe.utils.escape_html(mismatch_hint)}
							</div>
							<div class="pack-fg-qty-suggestions">${suggestions_html}</div>
						</div>`
						: ""
				}
			</div>
		`);
	};

	render_summary();

	if (!is_balanced) {
		fetch_qty_suggestions(frm, pick_qty, pack_qty, (suggestions_data) => {
			render_summary(render_qty_suggestions_html(suggestions_data));
		});
	}
}

function get_batch_filter_args(frm) {
	return {
		company: frm.doc.company,
		repack_items: (frm.doc.repack_items || []).filter((row) => row.item_code),
		posting_date: frm.doc.posting_date,
		posting_time: frm.doc.posting_time,
		item_group: "Packed Goods",
	};
}

function set_default_wip_fg_warehouse(frm) {
	if (!frm.doc.company) {
		frm._default_wip_fg_warehouse = null;
		return Promise.resolve(null);
	}

	return frappe
		.call({
			method:
				"packaging_app.packaging_management_application.doctype.repack.repack.get_default_wip_fg_warehouse_api",
			args: { company: frm.doc.company },
		})
		.then((r) => {
			frm._default_wip_fg_warehouse = r.message || null;
			return frm._default_wip_fg_warehouse;
		});
}

function apply_default_target_warehouse(frm) {
	for (const row of frm.doc.packed_fg_items || []) {
		if (!row.target_warehouse && frm._default_wip_fg_warehouse) {
			set_model_value_if_changed(row.doctype, row.name, {
				target_warehouse: frm._default_wip_fg_warehouse,
			});
		}
	}
}

function get_picked_qty_map(frm) {
	const picked = {};
	const bundle_names = [
		...new Set(
			(frm.doc.repack_items || [])
				.filter((row) => row.serial_and_batch_bundle)
				.map((row) => row.serial_and_batch_bundle)
		),
	];

	if (!bundle_names.length) {
		return Promise.resolve({});
	}

	return Promise.all(
		bundle_names.map((name) =>
			frappe.call({
				method: "frappe.client.get",
				args: { doctype: "Serial and Batch Bundle", name },
			})
		)
	).then((responses) => {
		for (const r of responses) {
			for (const entry of r.message?.entries || []) {
				if (entry.batch_no) {
					picked[entry.batch_no] =
						(picked[entry.batch_no] || 0) + Math.abs(flt(entry.qty));
				}
			}
		}
		return picked;
	});
}

function render_item_batch_ui(frm) {
	const field = frm.get_field("item_batch_ui");
	if (!field) {
		return;
	}

	toggle_repack_workflow_ui(frm);
	if (!is_repack_editable(frm)) {
		field.$wrapper.empty();
		return;
	}

	if (!frm.doc.company) {
		field.$wrapper.html(`
			<div class="repack-batch-ui" style="${REPACK_SECTION_DIVIDER}">
				${render_batch_filter_banner(null, null, null)}
				<div style="padding: 12px; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; background: #ffebee; color: #c62828; font-size: 13px;">
					${__("Please select a Company to load batches.")}
				</div>
			</div>
		`);
		update_qty_summary(frm);
		return;
	}

	const is_readonly = frm.doc.docstatus !== 0;
	const filter_args = get_batch_filter_args(frm);
	const repack_rows = get_repack_rows(frm);

	field.$wrapper.html(`
		<div class="repack-batch-ui" style="${REPACK_SECTION_DIVIDER}">
			${render_batch_filter_banner(repack_rows, frm.doc.company, frm._default_wip_fg_warehouse)}
			<div class="text-muted small" style="padding: 8px 0;">${__("Loading batches...")}</div>
		</div>
	`);

	get_picked_qty_map(frm).then((picked_qty_map) => {
		frappe.call({
			method:
				"packaging_app.packaging_management_application.doctype.repack.repack.get_active_batches_for_repack",
			args: filter_args,
			callback: (r) => {
				const batches = r.message || [];
				let html = `<div class="repack-batch-ui" style="${REPACK_SECTION_DIVIDER}">`;
				html += render_batch_filter_banner(
					repack_rows,
					frm.doc.company,
					frm._default_wip_fg_warehouse
				);

				if (!repack_rows.length) {
					html += `<div style="padding: 10px 12px; margin-bottom: 10px; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; background: var(--subtle-accent, #f8f9fa); color: var(--text-muted, #6c757d); font-size: 12px;">
						${__("Select an item in Repack Items to filter batches.")}
					</div>`;
				}

				if (!batches.length) {
					html += `<div style="padding: 12px; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; background: #ffebee; color: #c62828; font-size: 13px;">
						${__("No active batches found.")}
					</div></div>`;
					field.$wrapper.html(html);
					update_qty_summary(frm);
					return;
				}

				html += `<div style="max-height: 360px; overflow-y: auto; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px;">
					<table class="table table-bordered table-sm" style="margin-bottom: 0; background: var(--fg-color, #fff);">
					<thead style="background: var(--subtle-accent, #f8f9fa);">
						<tr>
							<th style="font-size: 12px;">${__("Batch No")}</th>
							<th style="font-size: 12px;">${__("Item")}</th>
							<th style="font-size: 12px;">${__("Warehouse")}</th>
							<th class="text-right" style="font-size: 12px;">${__("Available Qty")}</th>
							<th class="text-right" style="font-size: 12px;">${__("Filling Capacity")}</th>
							<th class="text-right" style="font-size: 12px;">${__("Density")}</th>
							<th class="text-right" style="font-size: 12px;">${__("Pick Qty")}</th>
							<th class="text-right" style="font-size: 12px;">${__("Total Qty")}</th>
							<th class="text-center" style="font-size: 12px;">${__("Select Batch")}</th>
						</tr>
					</thead>
					<tbody>`;

				const selected_batch_no = get_selected_batch_no(picked_qty_map, frm);

				for (const batch of batches) {
					const pick_qty = picked_qty_map[batch.batch_no] || 0;
					const row_total_qty = flt(batch.filling_capacity) * flt(pick_qty);
					const is_selected = batch.batch_no === selected_batch_no;
					const disabled = is_readonly ? "disabled" : "";
					const row_style = is_selected
						? "background-color: var(--subtle-accent, #f8f9fa);"
						: "";
					html += `<tr data-batch-no="${frappe.utils.escape_html(batch.batch_no)}" data-item-code="${frappe.utils.escape_html(batch.item_code || "")}" style="${row_style}">
						<td>${frappe.utils.escape_html(batch.batch_no)}</td>
						<td>${render_batch_item_label(batch)}</td>
						<td>${frappe.utils.escape_html(batch.warehouse || "")}</td>
						<td class="text-right">${format_number(batch.available_qty)}</td>
						<td class="text-right">${format_number(batch.filling_capacity)}</td>
						<td class="text-right">${format_number(batch.density)}</td>
						<td class="text-right">
							<input type="number" class="form-control input-sm batch-pick-qty text-right"
								min="0" max="${batch.available_qty}" step="any"
								data-available-qty="${batch.available_qty}"
								data-filling-capacity="${flt(batch.filling_capacity)}"
								data-item-code="${frappe.utils.escape_html(batch.item_code)}"
								data-warehouse="${frappe.utils.escape_html(batch.warehouse || "")}"
								value="${pick_qty || ""}" ${disabled}
								style="width: 100px; display: inline-block;">
						</td>
						<td class="text-right batch-total-qty">${format_number(row_total_qty)}</td>
						<td class="text-center">
							<input type="checkbox" class="batch-select-checkbox"
								${is_selected ? "checked" : ""} ${disabled}
								aria-label="${__("Select Batch")}">
						</td>
					</tr>`;
				}

				html += `</tbody></table></div>`;

				html += `</div>`;
				field.$wrapper.html(html);

				const highlight_selected_batch_row = ($wrapper) => {
					$wrapper.find("tbody tr").each((_, tr) => {
						const $tr = $(tr);
						const is_selected = $tr.find(".batch-select-checkbox").is(":checked");
						$tr.css(
							"background-color",
							is_selected ? "var(--subtle-accent, #f8f9fa)" : ""
						);
					});
				};

				const update_total = ({ sync_model = false } = {}) => {
					let pick_total = 0;
					let liters_total = 0;

					field.$wrapper.find("tbody tr").each((_, tr) => {
						const $tr = $(tr);
						const row_total = update_batch_row_total_qty($tr);
						const pick_qty = flt($tr.find(".batch-pick-qty").val());
						pick_total += pick_qty;
						liters_total += row_total;
					});

					if (!pick_total) {
						pick_total = (frm.doc.repack_items || []).reduce(
							(sum, row) => sum + flt(row.qty),
							0
						);
						const target_row = (frm.doc.packed_fg_items || [])[0];
						if (target_row) {
							liters_total = flt(target_row.qty);
						}
					}

					const after_summary = () => update_qty_summary(frm, pick_total);
					if (sync_model) {
						sync_semi_product_from_batch_ui(frm, pick_total, liters_total).then(
							after_summary
						);
						return;
					}

					after_summary();
				};

				field.$wrapper.find(".batch-select-checkbox").on("change", function () {
					if ($(this).is(":checked")) {
						field.$wrapper
							.find(".batch-select-checkbox")
							.not(this)
							.prop("checked", false);
						const primary_batch_no = $(this).closest("tr").data("batch-no");
						preview_semi_product_batch_from_selection(frm, primary_batch_no);
					}
					highlight_selected_batch_row(field.$wrapper);
					update_total({ sync_model: true });
				});

				field.$wrapper.find(".batch-pick-qty").on("input change blur", function () {
					validate_batch_pick_qty($(this));
					update_total({ sync_model: true });
				});

				highlight_selected_batch_row(field.$wrapper);
				update_total({ sync_model: false });

				update_repack_form_actions(frm);
				setup_apply_batches_button(frm);
			},
		});
	});
}

function get_selected_batch_no(picked_qty_map, frm) {
	if (frm?.doc?.batch_no) {
		return frm.doc.batch_no;
	}

	for (const [batch_no, qty] of Object.entries(picked_qty_map || {})) {
		if (flt(qty) > 0) {
			return batch_no;
		}
	}
	return null;
}

function find_repack_row(frm, item_code, warehouse) {
	return (frm.doc.repack_items || []).find(
		(row) =>
			row.item_code === item_code &&
			(!warehouse || !row.source_warehouse || row.source_warehouse === warehouse)
	);
}

function collect_batch_picks_by_repack_row($wrapper, frm) {
	const picks_by_key = {};

	$wrapper.find("tbody tr").each((_, tr) => {
		const $tr = $(tr);
		const $input = $tr.find(".batch-pick-qty");
		const pick_qty = flt($input.val());

		if (pick_qty <= 0) {
			return;
		}

		const available_qty = flt($input.data("available-qty"));
		const batch_item_code = $input.data("item-code");
		const batch_warehouse = $input.data("warehouse");
		const batch_no = $tr.data("batch-no");

		if (pick_qty > available_qty) {
			frappe.throw(
				__("Pick Qty for batch {0} cannot exceed available qty {1}", [batch_no, available_qty])
			);
		}

		const repack_row = find_repack_row(frm, batch_item_code, batch_warehouse);
		if (!repack_row) {
			frappe.throw(
				__("Batch {0} belongs to item {1} which is not in Repack Items", [
					batch_no,
					batch_item_code,
				])
			);
		}

		if (batch_warehouse && batch_warehouse !== repack_row.source_warehouse) {
			frappe.throw(
				__("Batch {0} is in warehouse {1}, not {2}", [
					batch_no,
					batch_warehouse,
					repack_row.source_warehouse,
				])
			);
		}

		const key = repack_row.name;
		if (!picks_by_key[key]) {
			picks_by_key[key] = { repack_row, entries: [], total_picked: 0 };
		}

		picks_by_key[key].entries.push({ batch_no, qty: pick_qty });
		picks_by_key[key].total_picked += pick_qty;
	});

	return picks_by_key;
}

function validate_batch_pick_qty($input) {
	const available_qty = flt($input.data("available-qty"));
	let pick_qty = flt($input.val());
	const batch_no = $input.closest("tr").data("batch-no");

	if (pick_qty < 0) {
		pick_qty = 0;
		$input.val(pick_qty);
	}

	if (pick_qty > available_qty) {
		$input.css({
			"border-color": "#c62828",
			"background-color": "#ffebee",
		});
		frappe.show_alert(
			{
				message: __(
					"Pick Qty for batch {0} cannot exceed Available Qty ({1})",
					[batch_no, format_number(available_qty)]
				),
				indicator: "red",
			},
			5
		);
		$input.val(available_qty || "");
		return false;
	}

	$input.css({
		"border-color": "",
		"background-color": "",
	});
	return true;
}

function apply_batch_selection(frm, $wrapper) {
	const repack_rows = (frm.doc.repack_items || []).filter(
		(row) => row.item_code && row.source_warehouse
	);

	if (!repack_rows.length) {
		frappe.throw(__("Please add Repack Items with Item Code and Source Warehouse"));
	}

	const $selected_row = $wrapper.find(".batch-select-checkbox:checked").closest("tr");
	if (!$selected_row.length) {
		frappe.throw(__("Please select a batch"));
	}

	const primary_batch_no = $selected_row.data("batch-no");
	const picks_by_key = collect_batch_picks_by_repack_row($wrapper, frm);
	const pick_groups = Object.values(picks_by_key);

	if (!pick_groups.length) {
		frappe.throw(__("Please enter pick quantity for at least one batch"));
	}

	let total_picked = 0;

	frappe.dom.freeze(__("Applying batches..."));

	const apply_bundles_sequentially = async () => {
		for (const { repack_row, entries, total_picked: row_total } of pick_groups) {
			total_picked += row_total;
			const child_row = {
				...repack_row,
				type_of_transaction: "Outward",
				s_warehouse: repack_row.source_warehouse,
				warehouse: repack_row.source_warehouse,
				parenttype: "Repack",
			};

			const r = await frappe.call({
				method:
					"erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle.add_serial_batch_ledgers",
				args: {
					entries,
					child_row,
					doc: frm.doc,
					warehouse: repack_row.source_warehouse,
				},
			});

			if (r.message) {
				await frappe.model.set_value(repack_row.doctype, repack_row.name, {
					serial_and_batch_bundle: r.message.name,
					qty: row_total,
				});
			}
		}
	};

	apply_bundles_sequentially()
		.then(() => {
			frm.set_value("batch_no", primary_batch_no);
			frm.refresh_field("repack_items");

			return link_semi_product_batches(frm, primary_batch_no).then((batch_result) => {
				update_qty_summary(frm, total_picked);
				const semi_product_batch_id = batch_result?.semi_product_batch_id || "";
				frappe.show_alert({
					message: semi_product_batch_id
						? __("Batch bundle applied. Semi product batch {0} created and linked.", [
								semi_product_batch_id,
							])
						: __("Batch bundles applied"),
					indicator: "green",
				});
				render_item_batch_ui(frm);
				update_repack_form_actions(frm);
			});
		})
		.finally(() => {
			frappe.dom.unfreeze();
		});
}
