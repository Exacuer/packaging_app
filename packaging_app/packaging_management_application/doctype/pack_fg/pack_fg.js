// Copyright (c) 2026, Vivek Choudhary and contributors
// For license information, please see license.txt

frappe.ui.form.on("Pack FG", {
	setup(frm) {
		frm.ignore_doctypes_on_cancel_all = ["Serial and Batch Bundle"];
	},

	refresh(frm) {
		if (frm.doc.packing_items && frm.doc.packing_items.length > 0) {
			frm.set_df_property("packing_items", "cannot_add_rows", true);
		}
		if (!frm.doc.posting_date) {
			frm.set_value("posting_date", frappe.datetime.get_today());
		}
		if (!frm.doc.posting_time) {
			frm.set_value("posting_time", frappe.datetime.now_time());
		}
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
		setup_packed_fg_header(frm);
		render_item_batch_ui(frm);
	},

	company(frm) {
		render_item_batch_ui(frm);
	},

	posting_date(frm) {
		render_item_batch_ui(frm);
	},

	posting_time(frm) {
		render_item_batch_ui(frm);
	},

	validate(frm) {
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
			frappe.throw(
				__(
					"Total Pick Qty ({0}) must equal Total Packed FG Items Qty ({1}) across all packed rows",
					[flt(pick_qty_from_ui, precision), flt(packed_qty, precision)]
				)
			);
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

			frappe.throw(
				__(
					"Total Pick Qty ({0}) must equal Total Packed FG Items Qty ({1}) across all packed rows",
					[flt(packing_qty, precision), flt(packed_qty, precision)]
				)
			);
		}
	},
});

frappe.ui.form.on("Pack FG Item Source", {
	packing_items_add(frm) {
		if (frm.doc.packing_items && frm.doc.packing_items.length > 0) {
			frm.set_df_property("packing_items", "cannot_add_rows", true);
		}
		render_item_batch_ui(frm);
	},

	packing_items_remove(frm) {
		if (frm.doc.packing_items && frm.doc.packing_items.length === 0) {
			frm.set_df_property("packing_items", "cannot_add_rows", false);
		}
		frm.clear_table("packed_fg_items");
		frm.refresh_field("packed_fg_items");
		frm.set_value("batch_no", "");
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
	},
});

frappe.ui.form.on("Pack FG Item Target", {
	pack_qty(frm, cdt, cdn) {
		calculate_packed_qty(frm, cdt, cdn);
		update_qty_summary(frm);
	},

	filling_capacity(frm, cdt, cdn) {
		calculate_packed_qty(frm, cdt, cdn);
		update_qty_summary(frm);
	},

	qty(frm) {
		update_qty_summary(frm);
	},

	packed_fg_items_remove(frm) {
		update_qty_summary(frm);
	},

	packed_fg_items_add(frm, cdt, cdn) {
		let child = locals[cdt][cdn];
		if (frm.doc.packing_items && frm.doc.packing_items.length > 0) {
			child.target_warehouse = frm.doc.packing_items[0].source_warehouse;
		}
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

function render_batch_filter_banner(packing_row, company) {
	if (packing_row?.item_code) {
		const item_html = render_status_chip(packing_row.item_code, true);
		const warehouse_html = render_status_chip(
			packing_row.source_warehouse || __("Any"),
			!!packing_row.source_warehouse
		);

		return render_section_header(
			__("Batch Selection"),
			`<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px;">
				<span class="text-muted">${__("Item")}:</span> ${item_html}
				<span class="text-muted">${__("Warehouse")}:</span> ${warehouse_html}
			</div>`
		);
	}

	const company_chip = render_status_chip(company, !!company);
	return render_section_header(
		__("Batch Selection"),
		`<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px;">
			<span class="text-muted">${__("Company")}:</span> ${company_chip}
			<span class="text-muted">${__("Item")}:</span> ${render_status_chip(null, false)}
			<span class="text-muted">${__("Warehouse")}:</span> ${render_status_chip(null, false)}
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

function render_qty_stat(label, value, accent) {
	return `
		<div class="pack-fg-stat" style="
			background: var(--fg-color, #fff);
			border: 1px solid var(--border-color, #d1d8dd);
			border-left: 3px solid ${accent};
			border-radius: 6px;
			padding: 8px 14px;
			min-width: 120px;
			text-align: center;
		">
			<div class="text-muted small" style="margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.03em; font-size: 11px;">
				${label}
			</div>
			<div style="font-size: 16px; font-weight: 600; line-height: 1.2;">
				${format_number(flt(value))}
			</div>
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

	field.$wrapper.html(`
		<div class="pack-fg-qty-summary" style="${PACK_FG_SECTION_DIVIDER} padding-bottom: 10px;">
			<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
				<span style="font-size: 14px; font-weight: 600;">${__("Packed FG Items")}</span>
				<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
					${render_qty_stat(__("Pick Qty"), pick_qty, "var(--blue-500, #2490ef)")}
					${render_qty_stat(__("Pack Qty"), pack_qty, "var(--purple-500, #743ee2)")}
					${render_qty_stat(__("Packed Qty"), packed_qty, "var(--green-500, #28a745)")}
					<div title="${balance_text}" style="
						display: flex;
						align-items: center;
						justify-content: center;
						width: 32px;
						height: 32px;
						border-radius: 50%;
						background: ${balance_color};
						color: #fff;
						font-weight: 700;
						font-size: 14px;
						flex-shrink: 0;
					">${balance_icon}</div>
				</div>
			</div>
		</div>
	`);
}

function get_batch_filter_args(frm) {
	const packing_row = get_packing_row(frm);
	return {
		company: frm.doc.company,
		item_code: packing_row?.item_code || null,
		warehouse: packing_row?.source_warehouse || null,
		posting_date: frm.doc.posting_date,
		posting_time: frm.doc.posting_time,
	};
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
				${render_batch_filter_banner(null, null)}
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
			${render_batch_filter_banner(packing_row, frm.doc.company)}
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
				html += render_batch_filter_banner(packing_row, frm.doc.company);

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
							<th class="text-right" style="font-size: 12px;">${__("Pick Qty")}</th>
							<th class="text-center" style="font-size: 12px;">${__("Select Batch")}</th>
						</tr>
					</thead>
					<tbody>`;

				const selected_batch_no = get_selected_batch_no(picked_qty_map, frm);

				for (const batch of batches) {
					const pick_qty = picked_qty_map[batch.batch_no] || 0;
					const is_selected = batch.batch_no === selected_batch_no;
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
					</tr>`;
				}

				html += `</tbody></table></div>`;

				if (!is_readonly) {
					html += `<div class="text-right" style="margin-top: 10px;">
						<button type="button" class="btn btn-primary btn-sm btn-apply-batches">${__(
							"Apply Batches"
						)}</button>
					</div>`;
				}

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

				field.$wrapper.find(".batch-pick-qty").on("input change blur", function () {
					validate_batch_pick_qty($(this));
					update_total();
				});

				highlight_selected_batch_row(field.$wrapper);
				update_total();

				if (!is_readonly) {
					field.$wrapper.find(".btn-apply-batches").on("click", () => {
						apply_batch_selection(frm, field.$wrapper);
					});
				}
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
			update_qty_summary(frm, total_picked);
			frappe.show_alert({
				message: __("Batch bundle {0} applied", [bundle.name]),
				indicator: "green",
			});
			render_item_batch_ui(frm);
		},
	});
}
