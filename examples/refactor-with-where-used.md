# Refactor with where-used safety

**Goal:** Rename a method on a popular interface; understand the blast radius
before touching anything.

## Prompt

> I want to rename method `CALC_TOTAL` on interface `ZIF_PRICING` to
> `CALCULATE_TOTAL`. Find every implementer and every caller on DEV first.
> Don't change anything yet — just give me the list and tell me roughly how
> much work this is.

## Tools the agent should reach for

1. `adt_where_used { object: "ZIF_PRICING", type: "interface" }` to find all
   references (implementers + callers)
2. `adt_get_source` selectively for the call sites the agent flags as
   ambiguous

## When you're ready to apply changes

> OK go ahead. Update every implementing class and every caller. Use transport
> `E4DK900789`. After updating, run a syntax check on each file before moving
> on, and abort if anything fails to parse.

Tools: `adt_set_source` (with `transport` argument), `adt_syntax_check`,
optionally `adt_activate` at the end.

> [!NOTE]
> Set `readOnly: false` for the system in your config, or this won't work.
> Always rehearse refactors against DEV first, never against PRD.
