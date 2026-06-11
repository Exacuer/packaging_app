---
name: pack-fg
description: >-
  Complete guide for Pack FG doctype in packaging_app (Frappe/ERPNext 15):
  batch selection HTML UI, packed FG items, alternate batch ID format,
  qty validation with warehouse suggestions, Repack Stock Entry per packed row.
  Use when editing pack_fg.py, pack_fg.js, packed_fg_items, Apply Batches,
  batch creation, stock entry on submit, or any packaging repack feature.
disable-model-invocation: true
---

# Pack FG — Complete Implementation Skill

## Purpose

**Pack FG** repacks bulk finished goods (liters) from source batches into packaged FG items (cans/containers counted in NOS). On submit it creates **Repack Stock Entries** — one per packed row — consuming bulk FG and receiving packaged FG with batch tracking.

**App**: `packaging_app` only. **Never modify** ERPNext or Frappe core — read only.

**Naming series**: `FGP` (e.g. `FGP00006`).

---

## What Was Built (Session Changelog)

Use this section to understand evolution and avoid reverting intentional decisions.

| # | Feature | Details |
|---|---------|---------|
| 1 | **Custom Batch Selection UI** | Replaced ERPNext `add_serial_batch_bundle` button with HTML table in `item_batch_ui` field |
| 2 | **Multi-batch picking** | User can enter Pick Qty on **any** batch row; Apply creates bundle from **all rows with qty > 0** |
| 3 | **Select Batch checkbox** | One checkbox marks **primary** batch → sets parent `batch_no` (not the only picked batch) |
| 4 | **Pick qty validation** | Client caps pick qty ≤ available; red alert if exceeded |
| 5 | **Packed FG uniqueness** | Each `packed_fg_items` row must have a **unique** `item_code` |
| 6 | **Qty summary cards** | Thin pill-style chips: Pick Qty / Pack Qty / Packed Qty + balance indicator |
| 7 | **Qty mismatch suggestions** | When pick ≠ packed total, suggest which batches/warehouses to add or remove (multiple suggestions) |
| 8 | **Stock Entry per packed row** | One Repack SE per `packed_fg_items` row (not one SE with all targets) |
| 9 | **Target qty uses `pack_qty`** | Incoming Stock Entry line uses `pack_qty` (NOS), not `qty` (liters) |
| 10 | **Source qty uses `qty`** | Outgoing line uses liters = `filling_capacity × pack_qty` per packed row |
| 11 | **Batch pool splitting** | Source `serial_and_batch_bundle` split across packed rows via `allocate_bundle_qty_from_pool` |
| 12 | **Packed FG batch field** | Link → Batch on `Pack FG Item Target`; created on **Apply Batches** + ensured on **Save** |
| 13 | **Alternate batch ID** | Source `FG00021-2606-00003` → packed batch `FG00021/2606/00003` (swap `-` ↔ `/`) |
| 14 | **No batch create on SE submit** | Stock Entry only links existing batch; creation is Apply Batches / Save only |
| 15 | **Removed** | `total_qty` field on Pack FG; old `add_serial_batch_bundle` button (hidden via property setter) |
| 16 | **Bug fix** | Use `frappe.get_cached_value` not `frappe.db.get_cached_value` (Frappe 15) |

---

## File Map

```
pack_fg/
├── SKILL.md              ← this file
├── pack_fg.py            ← server logic
├── pack_fg.js            ← client UI + validation
├── pack_fg.json          ← parent doctype
├── test_pack_fg.py
../pack_fg_item_source/    ← child: bulk source (packing_items)
../pack_fg_item_target/    ← child: packed output (packed_fg_items)
../custom/pack_fg_item_source.json  ← property setters (hide old button)
../custom/stock_entry.json            ← custom_pack_fg field on Stock Entry
```

---

## Doctype Structure

### Pack FG (parent)

| Field | Type | Notes |
|-------|------|-------|
| `company` | Link → Company | Required |
| `posting_date` / `posting_time` | Date/Time | Default today/now |
| `naming_series` | Select | `FGP` |
| `batch_no` | Link → Batch | Read-only; primary source batch; set on Apply |
| `packing_items` | Table | Pack FG Item Source — **max 1 row** |
| `item_batch_ui` | HTML | Custom batch selection table |
| `batch_picked_summary` | HTML | Qty summary pills + mismatch suggestions |
| `packed_fg_items` | Table | Pack FG Item Target |

### Pack FG Item Source (`packing_items`)

| Field | Notes |
|-------|-------|
| `item_code` | Bulk FG; filtered to `Item.custom_product_group = Finished Goods` |
| `source_warehouse` | Where bulk is picked from |
| `qty` | Total picked liters; synced from bundle on save |
| `uom` | From item stock UOM (read-only) |
| `serial_and_batch_bundle` | Read-only; set by Apply Batches |

### Pack FG Item Target (`packed_fg_items`)

| Field | Notes |
|-------|-------|
| `item_code` | From **Packing Material Details** child of source item; unique per table |
| `target_warehouse` | Auto-set from source warehouse |
| `batch` | Link → Batch; alternate-format ID; created on Apply Batches |
| `filling_capacity` | From `item_code.custom_filling_capacity` |
| `pack_qty` | Count of packs (NOS) — used in Stock Entry target |
| `qty` | Liters = `filling_capacity × pack_qty` — used in Stock Entry source split |

### Custom fields (other doctypes)

- **Stock Entry**: `custom_pack_fg` → links back to Pack FG
- **Item**: `custom_filling_capacity`, `custom_product_group` (used in filters)
- **Packing Material Details** (Item child table): defines which packed items are available per bulk item

---

## End-to-End User Workflow

```
1. Create Pack FG → set Company, date/time
2. Add ONE row in Packing Items → bulk item + source warehouse
3. Add Packed FG Items → select packaging items (unique each)
   → set Pack Qty per row (Filling Capacity auto-fetched)
4. Batch Selection table loads active batches for item + warehouse
5. Enter Pick Qty on one or more batch rows
6. Check ONE "Select Batch" checkbox (primary → batch_no)
7. Click "Apply Batches"
   → Creates outward bundle on packing_items
   → Creates packed FG Batch docs (alternate ID) + links packed_fg_items.batch
8. Verify qty pills: Pick Qty = Packed Qty (sum of all packed row liters)
9. Save document (ensures batches exist)
10. Submit → creates one Stock Entry per packed row
```

---

## Quantity Rules (Critical)

```
packed_fg_items.qty = filling_capacity × pack_qty     (liters, per row)
packed_fg_items.pack_qty                            (NOS, per row — Stock Entry TARGET)

SUM(packing_items.qty)  ==  SUM(packed_fg_items.qty)   (total liters)
SUM(batch pick qty UI)  ==  SUM(packed_fg_items.qty)   (before save)
```

**Three displayed totals** (in `batch_picked_summary`):
- **Pick Qty** — sum of batch pick inputs (or bundle total after Apply)
- **Pack Qty** — sum of `pack_qty` across packed rows (total NOS count)
- **Packed Qty** — sum of `qty` across packed rows (total liters)

Green ✓ when Pick Qty = Packed Qty; orange ! when mismatch + suggestion panel.

---

## Batch Selection UI (`pack_fg.js`)

### Rendering
- `render_item_batch_ui(frm)` — called on refresh, company/date/time change, packing item changes
- `get_active_batches` API — uses ERPNext `get_auto_batch_nos`
- Filter banner shows Item + Warehouse status chips (green/red)
- Table columns: Batch No, Item, Warehouse, Available Qty, Pick Qty (input), Select Batch (checkbox)

### Apply Batches (`apply_batch_selection`)
1. Validate packing row, item, warehouse, checkbox selected, at least one pick qty > 0
2. `collect_batch_pick_entries` — validates pick ≤ available, item/warehouse match
3. Call `erpnext...add_serial_batch_ledgers` → creates `Serial and Batch Bundle`
4. Set `packing_items.serial_and_batch_bundle` + `qty` + parent `batch_no`
5. Call `create_and_link_packed_fg_batches` (server) → create packed batches + link rows
6. Refresh UI + qty summary

### Pick qty before Apply
- Pick qty lives only in HTML inputs until Apply
- `get_pick_qty_from_inputs` sums `.batch-pick-qty` values
- Client `validate` checks UI pick qty vs packed total

### After Apply
- `get_picked_qty_map` reads bundle entries to repopulate pick qty inputs
- `sync_packing_qty_from_bundle` (server) sets `packing_items.qty` from bundle on save

### Removed legacy
- `add_serial_batch_bundle` button hidden via `custom/pack_fg_item_source.json` property setters
- `serial_and_batch_bundle` is read-only on child row

---

## Alternate Batch ID Format

Packed FG batches use the **opposite separator** from the selected source batch:

| Source (parent `batch_no`) | Packed FG `batch` (new Batch doc name) |
|----------------------------|----------------------------------------|
| `FG00021-2606-00003` | `FG00021/2606/00003` |
| `FG00021/2606/00003` | `FG00021-2606-00003` |

```python
# pack_fg.py
def alternate_packed_fg_batch_id(source_batch):
    if "/" in str(source_batch):
        return str(source_batch).replace("/", "-")
    return str(source_batch).replace("-", "/")
```

Same logic in JS: `alternate_packed_fg_batch_id(source_batch)`.

### Batch creation timeline

| When | What |
|------|------|
| **Apply Batches** | `create_and_link_packed_fg_batches` → `create_packed_fg_batch` per packed row → set `packed_fg_items.batch` |
| **Save** | `create_packed_fg_batches` → idempotent ensure Batch exists |
| **Submit** | Stock Entry uses `packed_item.batch` only; **no** `make_batch` on submit |

`create_packed_fg_batch`:
- Uses `erpnext.stock.doctype.batch.batch.make_batch`
- Sets `reference_doctype=Pack FG`, `reference_name=pack_fg.name`
- Copies `expiry_date` / `manufacturing_date` from source batch via `resolve_source_batch_no`
- Throws if batch exists for a **different** item

**Constraint**: One Batch ID = one Item. Two packed rows with **different items** cannot share the same batch name.

---

## Stock Entry on Submit (`create_stock_entry`)

**One Stock Entry (Repack) per `packed_fg_items` row.**

### Per packed row:

**Source line** (bulk consumption):
- `item_code` = packing_items[0].item_code
- `qty` / `transfer_qty` = `packed_item.qty` (liters for this row's share)
- `s_warehouse` = source warehouse
- `serial_and_batch_bundle` = outward bundle split from pool (`allocate_bundle_qty_from_pool`)

**Target line** (packed receipt):
- `item_code` = packed_item.item_code
- `qty` / `transfer_qty` = **`packed_item.pack_qty`** (NOS)
- `t_warehouse` = target_warehouse
- `is_finished_item` = 1
- `serial_and_batch_bundle` = inward bundle with `packed_item.batch`

### Bundle pool
- `get_mutable_bundle_pool` reads source bundle entries
- Each packed row allocates liters from pool sequentially
- `create_outward_bundle` / `create_inward_bundle` create `Serial and Batch Bundle` docs

### Linking
- `se.custom_pack_fg = self.name`
- First SE name stored in `Pack FG.stock_entry` if column exists
- `cancel_stock_entry` cancels all SEs where `custom_pack_fg = self.name`

### Submit prerequisites
- Batch must exist: throws *"Batch X does not exist... Please save the document first"* if missing
- `pack_qty` required on each packed row

---

## Validation (`pack_fg.py` — order matters)

```python
def validate(self):
    self.calculate_packed_qty()           # qty = filling_capacity × pack_qty
    self.sync_packed_fg_batches()       # fill empty batch with alternate ID
    self.create_packed_fg_batches()     # ensure Batch docs exist
    self.validate_packed_fg_items_item()    # unique item_code
    self.validate_packed_fg_items_for_stock_entry()  # at least one packed row
    self.validate_packed_fg_items_batch()   # batch required if item has_batch_no
    self.validate_batch_bundle()        # bundle required if source item batch-tracked
    self.validate_qty()                 # pick total = packed total (+ suggestions)
```

### Client validate (`pack_fg.js`)
- Compares UI pick qty vs packed total
- Compares `packing_items.qty` vs packed total
- Special message if UI correct but packing qty stale → *"click Apply Batches before save"*
- Uses `throw_qty_mismatch_error` → calls `get_qty_balance_suggestions_api`

---

## Qty Mismatch Suggestions

When `pick_qty ≠ packed_qty`, show actionable guidance:

**Short (need more pick)** — `build_add_pick_suggestions`:
1. Source warehouse batches first (remaining available after current picks)
2. Then other warehouses if still short
3. Multiple batch lines until covered
4. Fallback: *"Or reduce Pack Qty on Packed FG Items by X liters total"*

**Excess (need less pick)** — `build_remove_pick_suggestions`:
1. Remove from current picks, largest batches first
2. Multiple batch lines
3. Fallback: *"Or increase Pack Qty on Packed FG Items by X liters total"*

**Example error message**:
```
Total Pick Qty (10) must equal Total Packed FG Items Qty (20) across all packed rows.
Short by 10 — add pick qty from:
• Add 10 from Batch FG00091-2606-00001 at WIP FG - PTPL
Or reduce Pack Qty on Packed FG Items by 10 liters total.
```

**UI**: Orange panel under qty pills with live suggestions via `fetch_qty_suggestions`.

---

## Whitelisted Server APIs

| Method | Args | Returns |
|--------|------|---------|
| `get_active_batches` | company, item_code?, warehouse?, posting_date?, posting_time? | `[{batch_no, item_code, item_name, warehouse, available_qty, expiry_date}]` |
| `create_and_link_packed_fg_batches` | source_batch_no, packed_items, pack_fg_name? | `{packed_batch_id, rows: [{name, batch}]}` |
| `get_qty_balance_suggestions_api` | company, pick_qty, packed_qty, item_code?, source_warehouse?, current_picks?, serial_and_batch_bundle?, posting_date?, posting_time? | suggestions + `message` |
| `get_item_packaging_material` | standard link query args + filters: item_code, exclude_items | `[(item, packing_item_name)]` |
| `get_packaging_material_details` | item_code | packing material rows |

---

## Client JS Reference

### Form handlers
- **Pack FG**: `setup`, `refresh`, `company`, `posting_date`, `posting_time`, `validate`
- **Pack FG Item Source**: `packing_items_add/remove`, `item_code`, `source_warehouse`
- **Pack FG Item Target**: `pack_qty`, `filling_capacity`, `qty`, `packed_fg_items_add/remove`, `item_code`

### Key functions
| Function | Purpose |
|----------|---------|
| `render_item_batch_ui` | Build batch HTML table |
| `apply_batch_selection` | Apply picks + create packed batches |
| `link_packed_fg_batches` | Call server batch create/link API |
| `alternate_packed_fg_batch_id` | Swap `-` ↔ `/` |
| `update_qty_summary` | Render pill cards + suggestions |
| `get_pick_qty` / `get_pick_qty_from_inputs` | Current pick total |
| `get_packed_totals` | Sum pack_qty and qty |
| `collect_batch_pick_entries` | Gather + validate pick rows |
| `validate_batch_pick_qty` | Cap pick ≤ available |
| `get_used_packed_fg_items` | Exclude duplicates in item query |
| `throw_qty_mismatch_error` | Save validate with suggestions |

### Queries (refresh)
- `batch` on packed_fg_items → filter `Batch.item = row.item_code`
- `item_code` on packed_fg_items → `get_item_packaging_material` with exclude list

### UX details
- Only **one** packing_items row allowed (`cannot_add_rows` after first add)
- Removing packing row clears packed_fg_items + batch_no
- Changing source item/warehouse clears bundle + re-renders batch UI
- `frm.ignore_doctypes_on_cancel_all = ["Serial and Batch Bundle"]`
- Section labels hidden for `item_batch_ui`, `packed_fg_items`, `batch_picked_summary` (custom headers in HTML)

---

## Server Python Reference

| Function | Purpose |
|----------|---------|
| `alternate_packed_fg_batch_id` | Swap batch ID separator |
| `resolve_source_batch_no` | Find source Batch doc (either format) |
| `create_packed_fg_batch` | Create or validate Batch for packed item |
| `create_and_link_packed_fg_batches` | Whitelisted; Apply Batches batch creation |
| `get_mutable_bundle_pool` | Parse source bundle into pool |
| `allocate_bundle_qty_from_pool` | Split liters per packed row |
| `create_outward_bundle` | Outward SABB for source line |
| `create_inward_bundle` | Inward SABB for target line |
| `get_bundle_total_qty` | Sum absolute qty in bundle |
| `build_qty_mismatch_message` | Full error text with suggestions |
| `build_add_pick_suggestions` / `build_remove_pick_suggestions` | Suggestion builders |
| `get_packaging_material_data` | Read Packing Material Details |

---

## Cancel Flow

`on_cancel` → `cancel_stock_entry`:
- Finds all submitted Stock Entries with `custom_pack_fg = self.name`
- Cancels each (newest first)

---

## Common Pitfalls & Fixes

| Issue | Solution |
|-------|----------|
| `frappe.db.get_cached_value` AttributeError | Use `frappe.get_cached_value` |
| `get_picked_qty_map(...).then is not a function` | Return `Promise.resolve({})` when no bundle |
| Pick qty clears on checkbox select | Do NOT clear/disable other rows on checkbox change |
| Stock Entry shows `qty` not `pack_qty` on target | Ensure target uses `packed_item.pack_qty` |
| Old SE after code change | Cancel Pack FG and resubmit |
| Batch field empty after Apply | Check `create_and_link_packed_fg_batches` response; item must have `has_batch_no` |
| Same batch ID, different packed items | ERPNext error — use unique batch per item |
| Link field not showing | Run `bench migrate` after JSON change |
| JS not updating | Hard refresh `Ctrl+Shift+R` |

---

## Testing Checklist

- [ ] Single packing row enforced
- [ ] Multi-batch pick (2+ batches) → one bundle, correct total
- [ ] Primary checkbox sets `batch_no` only
- [ ] Apply Batches → packed batch created with alternate ID + linked
- [ ] Pick Qty = Packed Qty validation (pass and fail with suggestions)
- [ ] Unique packed item enforcement
- [ ] Two packed rows → two Stock Entries on submit
- [ ] Target line qty = pack_qty (NOS); source = liters per row
- [ ] Cancel Pack FG cancels linked Stock Entries
- [ ] Save without Apply shows bundle/batch errors appropriately

---

## Extension Rules

1. **Only edit `packaging_app`** — never ERPNext/Frappe core
2. Imports at top of file (no inline imports unless circular, documented)
3. Add both server `validate` and client UX for new rules
4. Batch creation → Apply Batches / Save only, never Stock Entry submit
5. Stock Entry changes → `create_stock_entry` only
6. Match existing naming: `packing_items`, `packed_fg_items`, `pack_qty`, `batch_no`
7. After doctype JSON changes → `bench migrate`
8. TypeScript exhaustive switch not applicable (Python/JS form scripts)

---

## ERPNext Dependencies (read-only)

```
erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle.add_serial_batch_ledgers
erpnext.stock.doctype.serial_and_batch_bundle.serial_and_batch_bundle.get_auto_batch_nos
erpnext.stock.doctype.batch.batch.make_batch
```

Frappe docs: https://docs.frappe.io/framework/user/en/introduction
