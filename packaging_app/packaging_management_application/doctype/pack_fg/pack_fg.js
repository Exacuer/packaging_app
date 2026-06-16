// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.ui.form.on("Pack FG", {
	setup(frm) {
		frm.ignore_doctypes_on_cancel_all = ["Serial and Batch Bundle"];
	},

	refresh(frm) {
		if (frm.fields_dict?.packing_items?.grid) {
			frm.fields_dict.packing_items.grid.update_docfield_property("qty", "read_only", 1);
		}
		if (frm.doc.packing_items && frm.doc.packing_items.length > 0) {
			frm.set_df_property("packing_items", "cannot_add_rows", true);
		}
		if (!frm.doc.posting_date) {
			frm.set_value("posting_date", frappe.datetime.get_today());
		}
		if (!frm.doc.posting_time) {
			frm.set_value("posting_time", frappe.datetime.now_time());
		}
		frm.set_query("batch", "packed_fg_items", function (doc, cdt, cdn) {
			const row = locals[cdt][cdn];
			return {
				filters: {
					item: row.item_code || "",
				},
			};
		});

		frm.set_query("item_code", "packed_fg_items", function (doc, cdt, cdn) {
			let source_item = null;

			if (doc.packing_items?.length) {
				source_item = doc.packing_items[0].item_code;
			}

			return {
				query: "packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_item_packaging_material",
				filters: {
					item_code: source_item,
					exclude_items: get_used_packed_fg_items(doc, cdn),
				},
			};
		});
		setup_batch_section_header(frm);
		setup_packing_material_stock_header(frm);
		setup_packed_fg_header(frm);
		set_default_wip_fg_warehouse(frm).then(() => {
			apply_default_source_warehouse(frm);
			render_item_batch_ui(frm);
			render_packing_material_stock_ui(frm);
			update_pack_fg_form_actions(frm);
		});
	},

	company(frm) {
		set_default_wip_fg_warehouse(frm).then(() => {
			apply_default_source_warehouse(frm);
			render_item_batch_ui(frm);
			update_pack_fg_form_actions(frm);
		});
	},

	posting_date(frm) {
		render_item_batch_ui(frm);
	},

	posting_time(frm) {
		render_item_batch_ui(frm);
	},

	validate(frm) {
		if (frm.doc.packing_items?.length && !are_batches_applied(frm)) {
			frappe.throw(__("Please click Apply Batches before save."));
		}

		const packing_qty = (frm.doc.packing_items || []).reduce(
			(sum, item) => sum + flt(item.qty),
			0
		);
		const packed_qty = (frm.doc.packed_fg_items || []).reduce(
			(sum, item) => sum + flt(item.filling_capacity) * flt(item.pack_qty),
			0
		);
		const pick_qty_from_ui = get_pick_qty_from_inputs(frm);
		const precision = frappe.defaults.get_default("float_precision") || 3;

		if (flt(pick_qty_from_ui, precision) !== flt(packed_qty, precision)) {
			throw_qty_mismatch_error(frm, pick_qty_from_ui, packed_qty);
		}

		if (flt(packing_qty, precision) !== flt(packed_qty, precision)) {
			if (
				pick_qty_from_ui &&
				flt(pick_qty_from_ui, precision) === flt(packed_qty, precision)
			) {
				frappe.throw(
					__(
						"Packed quantities are correct but packing item qty is outdated. Please click Apply Batches before save."
					)
				);
			}

			throw_qty_mismatch_error(frm, packing_qty, packed_qty);
		}

		validate_packed_fg_warehouse_stock(frm, { async: false });
	},
});

frappe.ui.form.on("Pack FG Item Source", {
	packing_items_add(frm) {
		if (frm.doc.packing_items && frm.doc.packing_items.length > 0) {
			frm.set_df_property("packing_items", "cannot_add_rows", true);
		}
		apply_default_source_warehouse(frm);
		render_item_batch_ui(frm);
	},

	packing_items_remove(frm) {
		if (frm.doc.packing_items && frm.doc.packing_items.length === 0) {
			frm.set_df_property("packing_items", "cannot_add_rows", false);
		}
		frm.clear_table("packed_fg_items");
		frm.refresh_field("packed_fg_items");
		frm.set_value("batch_no", "");
		render_packing_material_stock_ui(frm);
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
		render_item_batch_ui(frm);
		render_packing_material_stock_ui(frm);
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
		for (let i = 0; i < frm.doc.packed_fg_items.length; i++) {
			frm.doc.packed_fg_items[i].target_warehouse = child.source_warehouse;
		}
		frm.refresh_field("packed_fg_items");
		render_item_batch_ui(frm);
		render_packing_material_stock_ui(frm);
	},
});

frappe.ui.form.on("Pack FG Item Target", {
	pack_qty(frm, cdt, cdn) {
		calculate_packed_qty(frm, cdt, cdn);
		update_qty_summary(frm);
		validate_packed_fg_warehouse_stock(frm, { rows: [locals[cdt][cdn]] });
	},

	filling_capacity(frm, cdt, cdn) {
		calculate_packed_qty(frm, cdt, cdn);
		update_qty_summary(frm);
		validate_packed_fg_warehouse_stock(frm, { rows: [locals[cdt][cdn]] });
	},

	qty(frm) {
		update_qty_summary(frm);
	},

	packed_fg_items_remove(frm) {
		update_qty_summary(frm);
		setup_apply_batches_button(frm);
	},

	packed_fg_items_add(frm, cdt, cdn) {
		let child = locals[cdt][cdn];
		if (frm.doc.packing_items && frm.doc.packing_items.length > 0) {
			child.target_warehouse = frm.doc.packing_items[0].source_warehouse;
		}
		set_packed_row_batch_if_enabled(frm, cdt, cdn);
		setup_apply_batches_button(frm);
	},

	item_code(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		if (!row.item_code) {
			return;
		}

		const is_duplicate = (frm.doc.packed_fg_items || []).some(
			(r) => r.item_code === row.item_code && r.name !== cdn
		);

		if (is_duplicate) {
			frappe.model.set_value(cdt, cdn, "item_code", "");
			frappe.throw(
				__("Item {0} is already selected in Packed FG Items", [row.item_code])
			);
		}

		set_packed_row_batch_if_enabled(frm, cdt, cdn);
	},

});

function calculate_packed_qty(frm, cdt, cdn) {
	let child = locals[cdt][cdn];
	let qty = flt(child.filling_capacity) * flt(child.pack_qty);
	frappe.model.set_value(cdt, cdn, "qty", qty);
}

function get_packing_row(frm) {
	return (frm.doc.packing_items || [])[0];
}

function validate_packed_fg_warehouse_stock(frm, options = {}) {
	const packing_row = get_packing_row(frm);
	if (!packing_row?.item_code || !packing_row?.source_warehouse) {
		return;
	}

	const packed_rows =
		options.rows ||
		(frm.doc.packed_fg_items || []).filter((row) => row.item_code && flt(row.pack_qty));

	if (!packed_rows.length) {
		return;
	}

	frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.validate_packed_fg_warehouse_stock_api",
		args: {
			source_fg_item: packing_row.item_code,
			source_warehouse: packing_row.source_warehouse,
			packed_fg_items: packed_rows,
			posting_date: frm.doc.posting_date,
			posting_time: frm.doc.posting_time,
		},
		async: options.async !== false,
	});
}

function are_batches_applied(frm) {
	const packing_row = get_packing_row(frm);
	return !!(packing_row?.serial_and_batch_bundle && frm.doc.batch_no);
}

function update_pack_fg_form_actions(frm) {
	if (frm.doc.docstatus !== 0) {
		return;
	}

	const show_save = are_batches_applied(frm);
	if (frm.page.btn_primary) {
		frm.page.btn_primary.toggle(show_save);
	}
}

function get_used_packed_fg_items(doc, current_cdn) {
	return (doc.packed_fg_items || [])
		.filter((row) => row.item_code && row.name !== current_cdn)
		.map((row) => row.item_code);
}

const PACK_FG_SECTION_DIVIDER = "border-top: 1px solid var(--border-color, #d1d8dd); margin-top: 12px; padding-top: 12px;";

function setup_batch_section_header(frm) {
	const field = frm.get_field("item_batch_ui");
	if (field) {
		field.$wrapper.closest(".frappe-control").find(".control-label").hide();
	}
}

function setup_packing_material_stock_header(frm) {
	const field = frm.get_field("packing_material_stock_ui");
	if (field) {
		field.$wrapper.closest(".frappe-control").find(".control-label").hide();
	}
}

function render_packing_material_stock_filters(warehouse) {
	return `<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px;">
		<span class="text-muted">${__("Warehouse")}:</span> ${render_status_chip(warehouse || __("Not set"), !!warehouse)}
	</div>`;
}

function render_packing_material_stock_ui(frm) {
	const field = frm.get_field("packing_material_stock_ui");
	if (!field) {
		return;
	}

	const packing_row = get_packing_row(frm);
	if (!packing_row?.item_code || !packing_row?.source_warehouse) {
		field.$wrapper.html(`
			<div class="pack-fg-material-stock-ui" style="${PACK_FG_SECTION_DIVIDER}">
				${render_section_header(__("Packing Item Code"), "")}
				<div style="padding: 10px 12px; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; background: var(--subtle-accent, #f8f9fa); color: var(--text-muted, #6c757d); font-size: 12px;">
					${__("Push an item to Packing Items to view packing item stock.")}
				</div>
			</div>
		`);
		return;
	}

	field.$wrapper.html(`
		<div class="pack-fg-material-stock-ui" style="${PACK_FG_SECTION_DIVIDER}">
			${render_section_header(__("Packing Item Code"), render_packing_material_stock_filters(packing_row.source_warehouse))}
			<div class="text-muted small" style="padding: 8px 0;">${__("Loading stock...")}</div>
		</div>
	`);

	frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_packing_material_stock",
		args: {
			item_code: packing_row.item_code,
			warehouse: packing_row.source_warehouse,
			posting_date: frm.doc.posting_date,
			posting_time: frm.doc.posting_time,
		},
		callback(r) {
			const data = r.message || {};
			const rows = data.rows || [];

			let html = `<div class="pack-fg-material-stock-ui" style="${PACK_FG_SECTION_DIVIDER}">`;
			html += render_section_header(
				__("Packing Item Code"),
				render_packing_material_stock_filters(data.warehouse || packing_row.source_warehouse)
			);

			if (!rows.length) {
				html += `<div style="padding: 10px 12px; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; background: #fff8e6; color: #8a6d3b; font-size: 12px;">
					${__("No Packing Material Details found for item {0}.", [packing_row.item_code])}
				</div></div>`;
				field.$wrapper.html(html);
				return;
			}

			html += `<div style="max-height: 280px; overflow-y: auto; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px;">
				<table class="table table-bordered table-sm" style="margin-bottom: 0; background: var(--fg-color, #fff);">
				<thead style="background: var(--subtle-accent, #f8f9fa);">
					<tr>
						<th style="font-size: 12px;">${__("Packing Item Code")}</th>
						<th style="font-size: 12px;">${__("Item Name")}</th>
						<th class="text-right" style="font-size: 12px;">${__("Filling Capacity")}</th>
						<th style="font-size: 12px;">${__("Item")}</th>
						<th class="text-right" style="font-size: 12px;">${__("Qty in Warehouse")}</th>
					</tr>
				</thead>
				<tbody>`;

			for (const row of rows) {
				html += `<tr>
					<td>${frappe.utils.escape_html(row.packing_item_code || row.item_code)}</td>
					<td>${frappe.utils.escape_html(row.item_name || "")}</td>
					<td class="text-right">${format_number(row.filling_capacity)}</td>
					<td>${frappe.utils.escape_html(row.packed_item_name || row.packed_item || "")}</td>
					<td class="text-right">${format_number(row.warehouse_qty)}</td>
				</tr>`;
			}

			html += `</tbody></table></div></div>`;
			field.$wrapper.html(html);
		},
	});
}

function setup_packed_fg_header(frm) {
	const packed_field = frm.get_field("packed_fg_items");
	if (packed_field) {
		packed_field.$wrapper.find(".control-label").hide();
	}
	const summary_field = frm.get_field("batch_picked_summary");
	if (summary_field) {
		summary_field.$wrapper.closest(".frappe-control").find(".control-label").hide();
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

function render_batch_filter_banner(packing_row, company, default_warehouse) {
	const warehouse = packing_row?.source_warehouse || default_warehouse;
	const item_label = packing_row?.item_code || __("Finished Goods");
	const has_item = !!packing_row?.item_code;

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
	const field = frm.get_field("item_batch_ui");
	if (!field) {
		return 0;
	}

	let total = 0;
	field.$wrapper.find(".batch-pick-qty").each((_, input) => {
		total += flt($(input).val());
	});
	return total;
}

function get_current_picks_from_ui(frm) {
	const field = frm.get_field("item_batch_ui");
	const packing_row = get_packing_row(frm);
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
					warehouse: $input.data("warehouse") || packing_row?.source_warehouse,
				});
			}
		});
	}

	return picks;
}

function throw_qty_mismatch_error(frm, pick_qty, packed_qty) {
	const precision = frappe.defaults.get_default("float_precision") || 3;
	const packing_row = get_packing_row(frm);
	let message = __(
		"Total Pick Qty ({0}) must equal Total Packed FG Items Qty ({1}) across all packed rows",
		[flt(pick_qty, precision), flt(packed_qty, precision)]
	);

	if (frm.doc.company && packing_row?.item_code) {
		frappe.call({
			method:
				"packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_qty_balance_suggestions_api",
			args: {
				company: frm.doc.company,
				item_code: packing_row.item_code,
				source_warehouse: packing_row.source_warehouse,
				pick_qty: flt(pick_qty, precision),
				packed_qty: flt(packed_qty, precision),
				current_picks: get_current_picks_from_ui(frm),
				serial_and_batch_bundle: packing_row.serial_and_batch_bundle,
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

function fetch_qty_suggestions(frm, pick_qty, packed_qty, callback) {
	const precision = frappe.defaults.get_default("float_precision") || 3;
	const packing_row = get_packing_row(frm);

	if (
		!frm.doc.company ||
		!packing_row?.item_code ||
		flt(pick_qty, precision) === flt(packed_qty, precision)
	) {
		callback(null);
		return;
	}

	frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_qty_balance_suggestions_api",
		args: {
			company: frm.doc.company,
			item_code: packing_row.item_code,
			source_warehouse: packing_row.source_warehouse,
			pick_qty: flt(pick_qty, precision),
			packed_qty: flt(packed_qty, precision),
			current_picks: get_current_picks_from_ui(frm),
			serial_and_batch_bundle: packing_row.serial_and_batch_bundle,
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
	return flt(get_packing_row(frm)?.qty);
}

function get_packed_totals(frm) {
	let pack_qty = 0;
	let packed_qty = 0;

	for (const row of frm.doc.packed_fg_items || []) {
		pack_qty += flt(row.pack_qty);
		packed_qty += flt(row.qty);
	}

	return { pack_qty, packed_qty };
}

const PACKED_FG_BATCH_SEPARATORS = ["/", ".", "\\", "_", "~", "|", ":"];

function split_batch_segments(source_batch) {
	const normalized = String(source_batch).replace(/\//g, "-");
	if (normalized.includes("-")) {
		return normalized.split("-");
	}
	return [normalized];
}

function add_separator_candidates(candidates, seen, segments, sep) {
	const single = segments.join(sep);
	if (!seen.has(single)) {
		seen.add(single);
		candidates.push(single);
	}

	const double_sep = sep + sep;
	if (double_sep !== sep) {
		const doubled = segments.join(double_sep);
		if (!seen.has(doubled)) {
			seen.add(doubled);
			candidates.push(doubled);
		}
	}
}

function generate_packed_fg_batch_candidates(source_batch) {
	const batch = String(source_batch || "").trim();
	if (!batch) {
		return [];
	}

	const segments = split_batch_segments(batch);
	if (segments.length <= 1) {
		return [batch];
	}

	const source_sep = batch.includes("/") ? "/" : "-";
	const seen = new Set();
	const candidates = [];

	const primary_sep = source_sep === "-" ? "/" : "-";
	add_separator_candidates(candidates, seen, segments, primary_sep);

	for (const sep of PACKED_FG_BATCH_SEPARATORS) {
		if (sep === source_sep) {
			continue;
		}
		add_separator_candidates(candidates, seen, segments, sep);
	}

	if (source_sep !== "-") {
		const fallback = segments.join("-");
		if (!seen.has(fallback)) {
			seen.add(fallback);
			candidates.push(fallback);
		}
	}

	return candidates;
}

function alternate_packed_fg_batch_id(source_batch) {
	return generate_packed_fg_batch_candidates(source_batch)[0] || "";
}

function set_packed_row_batch_if_enabled(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.item_code || !frm.doc.batch_no) {
		return;
	}

	frappe.db.get_value("Item", row.item_code, "has_batch_no", (r) => {
		if (r.message?.has_batch_no) {
			frappe.db.get_value("Batch", frm.doc.batch_no, "custom_density", (batch_r) => {
				frappe.model.set_value(cdt, cdn, {
					batch: alternate_packed_fg_batch_id(frm.doc.batch_no),
					density: flt(batch_r.message?.custom_density),
				});
			});
		} else {
			frappe.model.set_value(cdt, cdn, {
				batch: "",
				density: 0,
			});
		}
	});
}

function link_packed_fg_batches(frm, source_batch_no) {
	return frappe.call({
		method:
			"packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.create_and_link_packed_fg_batches",
		args: {
			source_batch_no,
			packed_items: frm.doc.packed_fg_items || [],
			pack_fg_name: frm.doc.name,
		},
	}).then((r) => {
		for (const row of r.message?.rows || []) {
			frappe.model.set_value("Pack FG Item Target", row.name, {
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

	const pick_qty = get_pick_qty(frm, override_pick);
	const { pack_qty, packed_qty } = get_packed_totals(frm);
	const precision = frappe.defaults.get_default("float_precision") || 3;
	const is_balanced =
		!pick_qty ||
		!packed_qty ||
		flt(pick_qty, precision) === flt(packed_qty, precision);
	const balance_color = is_balanced ? "var(--green-500, #28a745)" : "var(--orange-500, #e67e22)";
	const balance_icon = is_balanced ? "✓" : "!";
	const balance_text = is_balanced
		? __("Pick and Pack qty match")
		: __("Pick and Pack qty do not match");
	const diff = flt(packed_qty, precision) - flt(pick_qty, precision);
	const mismatch_hint = !is_balanced
		? diff > 0
			? __("Short by {0} — add pick qty from:", [format_number(diff)])
			: __("Excess of {0} — reduce pick qty from:", [format_number(Math.abs(diff))])
		: "";

	const render_summary = (suggestions_html = "") => {
		field.$wrapper.html(`
			<div class="pack-fg-qty-summary" style="${PACK_FG_SECTION_DIVIDER} padding-bottom: 8px;">
				<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
					<span style="font-size: 13px; font-weight: 600; color: var(--text-color, #333);">${__("Packed FG Items")}</span>
					<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">
						${render_qty_stat(__("Pick Qty"), pick_qty, "#2490ef")}
						${render_qty_stat(__("Pack Qty"), pack_qty, "#743ee2")}
						${render_qty_stat(__("Packed Qty"), packed_qty, "#28a745")}
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
		fetch_qty_suggestions(frm, pick_qty, packed_qty, (suggestions_data) => {
			render_summary(render_qty_suggestions_html(suggestions_data));
		});
	}
}

function get_batch_filter_args(frm) {
	const packing_row = get_packing_row(frm);
	return {
		company: frm.doc.company,
		item_code: packing_row?.item_code || null,
		warehouse: packing_row?.source_warehouse || frm._default_wip_fg_warehouse || null,
		posting_date: frm.doc.posting_date,
		posting_time: frm.doc.posting_time,
		product_group: "Finished Goods",
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
				"packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_default_wip_fg_warehouse_api",
			args: { company: frm.doc.company },
		})
		.then((r) => {
			frm._default_wip_fg_warehouse = r.message || null;
			return frm._default_wip_fg_warehouse;
		});
}

function apply_default_source_warehouse(frm) {
	const packing_row = get_packing_row(frm);
	if (!packing_row || packing_row.source_warehouse || !frm._default_wip_fg_warehouse) {
		return;
	}

	frappe.model.set_value(
		packing_row.doctype,
		packing_row.name,
		"source_warehouse",
		frm._default_wip_fg_warehouse
	);
}

function get_picked_qty_map(frm) {
	const packing_row = get_packing_row(frm);

	if (!packing_row?.serial_and_batch_bundle) {
		return Promise.resolve({});
	}

	return frappe
		.call({
			method: "frappe.client.get",
			args: {
				doctype: "Serial and Batch Bundle",
				name: packing_row.serial_and_batch_bundle,
			},
		})
		.then((r) => {
			const picked = {};
			for (const entry of r.message?.entries || []) {
				if (entry.batch_no) {
					picked[entry.batch_no] = (picked[entry.batch_no] || 0) + Math.abs(flt(entry.qty));
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

	if (!frm.doc.company) {
		field.$wrapper.html(`
			<div class="pack-fg-batch-ui" style="${PACK_FG_SECTION_DIVIDER}">
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
	const packing_row = get_packing_row(frm);

	field.$wrapper.html(`
		<div class="pack-fg-batch-ui" style="${PACK_FG_SECTION_DIVIDER}">
			${render_batch_filter_banner(packing_row, frm.doc.company, frm._default_wip_fg_warehouse)}
			<div class="text-muted small" style="padding: 8px 0;">${__("Loading batches...")}</div>
		</div>
	`);

	get_picked_qty_map(frm).then((picked_qty_map) => {
		frappe.call({
			method: "packaging_app.packaging_management_application.doctype.pack_fg.pack_fg.get_active_batches",
			args: filter_args,
			callback: (r) => {
				const batches = r.message || [];
				let html = `<div class="pack-fg-batch-ui" style="${PACK_FG_SECTION_DIVIDER}">`;
				html += render_batch_filter_banner(
					packing_row,
					frm.doc.company,
					frm._default_wip_fg_warehouse
				);

				if (!packing_row?.item_code) {
					html += `<div style="padding: 10px 12px; margin-bottom: 10px; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px; background: var(--subtle-accent, #f8f9fa); color: var(--text-muted, #6c757d); font-size: 12px;">
						${__("Select an item in Packing Items to filter batches.")}
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
							<th class="text-right" style="font-size: 12px;">${__("Density")}</th>
							<th class="text-right" style="font-size: 12px;">${__("Pick Qty")}</th>
							<th class="text-center" style="font-size: 12px;">${__("Select Batch")}</th>
							<th class="text-center" style="font-size: 12px;">${__("Push to Packing")}</th>
						</tr>
					</thead>
					<tbody>`;

				const selected_batch_no = get_selected_batch_no(picked_qty_map, frm);

				for (const batch of batches) {
					const pick_qty = picked_qty_map[batch.batch_no] || 0;
					const is_selected = batch.batch_no === selected_batch_no;
					const is_push_selected =
						packing_row?.item_code === batch.item_code &&
						(packing_row?.source_warehouse || "") === (batch.warehouse || "") &&
						(frm.doc.batch_no ? batch.batch_no === frm.doc.batch_no : false);
					const disabled = is_readonly ? "disabled" : "";
					const row_style = is_selected
						? "background-color: var(--subtle-accent, #f8f9fa);"
						: "";
					html += `<tr data-batch-no="${frappe.utils.escape_html(batch.batch_no)}" style="${row_style}">
						<td>${frappe.utils.escape_html(batch.batch_no)}</td>
						<td>${frappe.utils.escape_html(batch.item_code)}${
							batch.item_name ? ` - ${frappe.utils.escape_html(batch.item_name)}` : ""
						}</td>
						<td>${frappe.utils.escape_html(batch.warehouse || "")}</td>
						<td class="text-right">${format_number(batch.available_qty)}</td>
						<td class="text-right">${format_number(batch.density)}</td>
						<td class="text-right">
							<input type="number" class="form-control input-sm batch-pick-qty text-right"
								min="0" max="${batch.available_qty}" step="any"
								data-available-qty="${batch.available_qty}"
								data-item-code="${frappe.utils.escape_html(batch.item_code)}"
								data-warehouse="${frappe.utils.escape_html(batch.warehouse || "")}"
								value="${pick_qty || ""}" ${disabled}
								style="width: 100px; display: inline-block;">
						</td>
						<td class="text-center">
							<input type="checkbox" class="batch-select-checkbox"
								${is_selected ? "checked" : ""} ${disabled}
								aria-label="${__("Select Batch")}">
						</td>
						<td class="text-center">
							<input type="checkbox" class="batch-push-checkbox"
								${is_push_selected ? "checked" : ""} ${disabled}
								aria-label="${__("Push to Packing")}">
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

				const update_total = () => {
					let total = 0;
					field.$wrapper.find(".batch-pick-qty").each((_, input) => {
						total += flt($(input).val());
					});
					if (!total && packing_row?.qty) {
						total = flt(packing_row.qty);
					}
					update_qty_summary(frm, total);
				};

				field.$wrapper.find(".batch-select-checkbox").on("change", function () {
					if ($(this).is(":checked")) {
						field.$wrapper
							.find(".batch-select-checkbox")
							.not(this)
							.prop("checked", false);
					}
					highlight_selected_batch_row(field.$wrapper);
					update_total();
				});

				field.$wrapper.find(".batch-push-checkbox").on("change", function () {
					if ($(this).is(":checked")) {
						field.$wrapper
							.find(".batch-push-checkbox")
							.not(this)
							.prop("checked", false);
						upsert_packing_item_from_batch_row(frm, $(this).closest("tr"));
					}
				});

				field.$wrapper.find(".batch-pick-qty").on("input change blur", function () {
					validate_batch_pick_qty($(this));
					update_total();
				});

				highlight_selected_batch_row(field.$wrapper);
				update_total();

				update_pack_fg_form_actions(frm);
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

function upsert_packing_item_from_batch_row(frm, $tr) {
	const $input = $tr.find(".batch-pick-qty");
	const item_code = $input.data("item-code");
	const source_warehouse = $input.data("warehouse");
	const selected_batch_no = $tr.data("batch-no");

	if (!item_code || !source_warehouse) {
		frappe.show_alert(
			{
				message: __("Selected batch row is missing Item/Warehouse"),
				indicator: "orange",
			},
			5
		);
		return;
	}

	let row = get_packing_row(frm);

	if (!row) {
		row = frm.add_child("packing_items", {
			item_code,
			source_warehouse,
			qty: 0,
			serial_and_batch_bundle: "",
		});
		frm.set_value("batch_no", selected_batch_no || "");
		frm.set_df_property("packing_items", "cannot_add_rows", true);
		frm.refresh_field("packing_items");
		render_packing_material_stock_ui(frm);
		render_item_batch_ui(frm);
		update_pack_fg_form_actions(frm);
		return;
	}

	const row_changed = row.item_code !== item_code || row.source_warehouse !== source_warehouse;
	const updates = { item_code, source_warehouse };
	if (row_changed || row.serial_and_batch_bundle) {
		updates.serial_and_batch_bundle = "";
	}

	frappe.model.set_value(row.doctype, row.name, updates);
	frm.set_value("batch_no", selected_batch_no || "");
	frm.refresh_field("packing_items");
	render_packing_material_stock_ui(frm);
	render_item_batch_ui(frm);
	update_pack_fg_form_actions(frm);
}

function collect_batch_pick_entries($wrapper, packing_row) {
	const entries = [];
	let total_picked = 0;

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

		if (batch_item_code !== packing_row.item_code) {
			frappe.throw(
				__("Batch {0} belongs to item {1}, not {2}", [
					batch_no,
					batch_item_code,
					packing_row.item_code,
				])
			);
		}

		if (batch_warehouse && batch_warehouse !== packing_row.source_warehouse) {
			frappe.throw(
				__("Batch {0} is in warehouse {1}, not {2}", [
					batch_no,
					batch_warehouse,
					packing_row.source_warehouse,
				])
			);
		}

		entries.push({ batch_no, qty: pick_qty });
		total_picked += pick_qty;
	});

	return { entries, total_picked };
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
	const packing_row = get_packing_row(frm);

	if (!packing_row) {
		frappe.throw(__("Please add a row in Packing Items first"));
	}

	if (!packing_row.item_code) {
		frappe.throw(__("Please select an Item Code in Packing Items"));
	}

	if (!packing_row.source_warehouse) {
		frappe.throw(__("Please select a Source Warehouse in Packing Items"));
	}

	const $selected_row = $wrapper.find(".batch-select-checkbox:checked").closest("tr");
	if (!$selected_row.length) {
		frappe.throw(__("Please select a batch"));
	}

	const primary_batch_no = $selected_row.data("batch-no");
	const { entries, total_picked } = collect_batch_pick_entries($wrapper, packing_row);

	if (!entries.length) {
		frappe.throw(__("Please enter pick quantity for at least one batch"));
	}

	const child_row = {
		...packing_row,
		type_of_transaction: "Outward",
		s_warehouse: packing_row.source_warehouse,
		warehouse: packing_row.source_warehouse,
		parenttype: "Pack FG",
	};

	frappe.call({
		method: "erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle.add_serial_batch_ledgers",
		args: {
			entries,
			child_row,
			doc: frm.doc,
			warehouse: packing_row.source_warehouse,
		},
		callback: (r) => {
			if (!r.message) {
				return;
			}

			const bundle = r.message;
			frappe.model.set_value(packing_row.doctype, packing_row.name, {
				serial_and_batch_bundle: bundle.name,
				qty: total_picked,
			});
			frm.set_value("batch_no", primary_batch_no);
			frm.refresh_field("packing_items");

			link_packed_fg_batches(frm, primary_batch_no).then((batch_result) => {
				update_qty_summary(frm, total_picked);
				const packed_batch_id = batch_result?.packed_batch_id || "";
				frappe.show_alert({
					message: packed_batch_id
						? __("Batch bundle {0} applied. Packed batch {1} created and linked.", [
								bundle.name,
								packed_batch_id,
							])
						: __("Batch bundle {0} applied", [bundle.name]),
					indicator: "green",
				});
				render_item_batch_ui(frm);
				update_pack_fg_form_actions(frm);
			});
		},
	});
}
