# Scaffold a new class from spec

**Goal:** Have the agent create a new class, fill in its source, and activate
it — all in one chat turn, with safety checks along the way.

## Prompt

> On DEV, create class `ZCL_INVOICE_VALIDATOR` in package `ZLOCAL_INVOICE`
> with description "Invoice header validator". The class should have one
> public method `VALIDATE` that takes an invoice number and returns a result
> structure with ok flag + message. Implement it as a stub that always
> returns ok = abap_true. Activate when done. Use transport `E4DK900789`.

## Tools the agent should reach for

1. `adt_create_object { type: "class", name: "ZCL_INVOICE_VALIDATOR",
   package: "ZLOCAL_INVOICE", description: "Invoice header validator",
   transport: "E4DK900789" }`
2. `adt_set_source { object: "ZCL_INVOICE_VALIDATOR", type: "class",
   include: "definitions", source: "...class def with VALIDATE..." }`
3. `adt_set_source { object: "ZCL_INVOICE_VALIDATOR", type: "class",
   include: "implementations", source: "...METHOD VALIDATE..." }`
4. `adt_syntax_check { object: "ZCL_INVOICE_VALIDATOR", type: "class" }`
5. `adt_activate { objects: [{ name: "ZCL_INVOICE_VALIDATOR", type: "class" }] }`

## What to expect back

The agent's narration of each step + the final activation result. If syntax
check fails, the agent should fix the source and retry before activating —
not skip past errors.

> [!NOTE]
> `readOnly` must be `false` for the target system. Test the prompt against
> DEV first; never wire a creation flow against PRD.
