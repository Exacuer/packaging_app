---
name: pack-fg
description: >-
  Pack FG doctype in packaging_app: batch selection UI, packed FG items,
  qty validation with warehouse suggestions, alternate batch ID format,
  and Repack Stock Entry creation. Use when editing Pack FG, pack_fg.py,
  pack_fg.js, packed_fg_items, batch apply flow, or packaging repack logic.
disable-model-invocation: true
---

# Pack FG Doctype Skill

Custom Frappe/ERPNext doctype for repacking bulk FG into packaged finished goods.
**Only modify `packaging_app`** — do not change ERPNext or Frappe core.

## File Map

| File | Role |
|------|------|
| `pack_fg.py` | Server validation, batch creation, Stock Entry on submit |
| `pack_fg.js` | Batch selection HTML UI, qty summary, client validation |
| `pack_fg.json` | Parent doctype layout (`item_batch_ui`, `batch_picked_summary`) |
| `../pack_fg_item_source/` | Child: source bulk item + batch bundle |
| `../pack_fg_item_target/` | Child: packed output items (`batch` Link → Batch) |

## Data Model

### Parent: Pack FG
- `packing_items` → **Pack FG Item Source** (one row: bulk FG + warehouse + bundle)
- `packed_fg_items` → **Pack FG Item Target** (one row per unique packed item)
- `batch_no` → primary source batch (Link, read-only, set on Apply Batches)

### Packed row qty rules
```
packed_fg_items.qty = filling_capacity × pack_qty
Total pick qty (from bundles) = sum of all packed_fg_items.qty
```

### Stock Entry on submit
- **One Stock Entry (Repack) per `packed_fg_items` row**
- **Source line**: `packed_item.qty` (liters) from bulk item; batch split via bundle pool
- **Target line**: `packed_item.pack_qty` (NOS), `is_finished_item=1`
- Linked via `custom_pack_fg` on Stock Entry
- **Batch on target**: uses existing `packed_fg_items.batch` link — does **not** create Batch on submit

## Batch Selection UI (`pack_fg.js`)

Custom HTML in `item_batch_ui` field (not the old `add_serial_batch_bundle` button).

### Flow
1. `get_active_batches` loads batches filtered by company / item / warehouse
2. User enters **Pick Qty** per batch row; checks **one** primary batch (for `batch_no`)
3. **Apply Batches** → `add_serial_batch_ledgers` → sets `packing_items.serial_and_batch_bundle` + `qty`
4. Then `create_and_link_packed_fg_batches` creates packed batches and links `packed_fg_items.batch`

### Apply Batches sequence (client)
```
add_serial_batch_ledgers
  → set batch_no on parent
  → link_packed_fg_batches (server API)
  → refresh UI + qty summary
```

## Alternate Batch ID Format

Packed FG batches use the **opposite separator** from the source batch:

| Source batch | Packed FG batch ID |
|--------------|-------------------|
| `FG00021-2606-00003` | `FG00021/2606/00003` |
| `FG00021/2606/00003` | `FG00021-2606-00003` |

### Python
```python
def alternate_packed_fg_batch_id(source_batch):
    if "/" in str(source_batch):
        return str(source_batch).replace("/", "-")
    return str(source_batch).replace("-", "/")
```

### JS
```javascript
function alternate_packed_fg_batch_id(source_batch) { /* same logic */ }
```

### When batches are created
| Event | Action |
|-------|--------|
| **Apply Batches** | `create_and_link_packed_fg_batches` — create Batch per packed item, link row |
| **Save** | `create_packed_fg_batches` — ensure Batch exists (idempotent) |
| **Submit** | Use linked batch only; inward `Serial and Batch Bundle` |

`create_packed_fg_batch` copies expiry/manufacturing date from source batch via `resolve_source_batch_no`.

## Packed FG Items — Batch Field

- **Field type**: Link → Batch (`pack_fg_item_target.json`)
- **Query filter**: batches for `item_code` (`frm.set_query("batch", "packed_fg_items", ...)`)
- **Constraint**: one Batch ID belongs to one Item — different packed items cannot share the same batch name

## Qty Validation & Suggestions

### Server: `validate_qty` in `pack_fg.py`
Throws with `build_qty_mismatch_message` including batch/warehouse suggestions when pick ≠ packed total.

### APIs
- `get_qty_balance_suggestions_api` — structured suggestions
- `build_add_pick_suggestions` — batches/warehouses to add from
- `build_remove_pick_suggestions` — batches to reduce from

### Client
- `update_qty_summary` — thin pill-style Pick / Pack / Packed qty chips + live suggestions
- `throw_qty_mismatch_error` — same suggestions on save/submit validate

## Key Whitelisted APIs (`pack_fg.py`)

| Method | Purpose |
|--------|---------|
| `get_active_batches` | Batch table data for UI |
| `create_and_link_packed_fg_batches` | Create packed batches on Apply Batches |
| `get_qty_balance_suggestions_api` | Qty mismatch suggestions |
| `get_item_packaging_material` | Packed item link query (unique items) |

## Stock Entry Helpers (`pack_fg.py`)

| Function | Purpose |
|----------|---------|
| `get_mutable_bundle_pool` | Read source bundle qty pool |
| `allocate_bundle_qty_from_pool` | Split batch qty per packed row |
| `create_outward_bundle` | Outward bundle for source consumption |
| `create_inward_bundle` | Inward bundle for finished goods receipt |

## Validation Checklist

On `validate()` order matters:
1. `calculate_packed_qty`
2. `sync_packed_fg_batches` — fill empty batch IDs (alternate format)
3. `create_packed_fg_batches` — ensure Batch docs exist
4. `validate_packed_fg_items_item` — unique items in packed table
5. `validate_packed_fg_items_batch` — batch required if item has batch
6. `validate_batch_bundle` — source bundle required for batch-tracked items
7. `validate_qty` — pick total = packed total

## Client Conventions

- `get_packing_row(frm)` — first `packing_items` row (only one allowed)
- `get_pick_qty_from_inputs` — sum of `.batch-pick-qty` inputs (before Apply)
- `get_packed_totals` — sum `pack_qty` and `qty` from packed rows
- Pick qty cap: client blocks pick > available per batch row
- `packed_fg_items` item query excludes already-used items

## Common Pitfalls

1. **Use `frappe.get_cached_value`**, not `frappe.db.get_cached_value` (Frappe 15)
2. **Save before submit** if batches were not created via Apply Batches
3. **Hard refresh** (`Ctrl+Shift+R`) after JS changes
4. **Run `bench migrate`** after child doctype JSON changes (e.g. batch Link field)
5. Do not create Batch on Stock Entry submit — only on Apply Batches / Save
6. Resubmit after logic changes: cancel Pack FG to cancel linked Stock Entries

## UI Summary Cards

`render_qty_stat` in `pack_fg.js` — compact horizontal pills:
- Pick Qty (blue), Pack Qty (purple), Packed Qty (green)
- Balance indicator (green ✓ / orange !) when totals mismatch

## Extension Guidelines

When adding features:
- Keep imports at top of module (no inline imports)
- Match existing naming (`packed_fg_items`, `packing_items`)
- Add server validation + client UX for the same rule
- Test: multi-batch pick, multi packed rows, batch-tracked and non-batch items
- Stock Entry changes stay in `create_stock_entry`; batch creation stays in `create_packed_fg_batch`

## Related ERPNext (read-only)

- `erpnext.stock.doctype.serial_and_batch_bundle.add_serial_batch_ledgers`
- `erpnext.stock.doctype.batch.batch.make_batch`
- `get_auto_batch_nos` for available batches
