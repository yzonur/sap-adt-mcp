# Audit a class

**Goal:** Get a quality read on a single class without opening Eclipse.

## Prompt

> Audit class `ZCL_PRICING_ENGINE` on DEV. I want to know: what its public
> contract looks like, who uses it, whether it has unit tests, and whether ATC
> finds anything. Skip cosmetic warnings — I only care about structural issues
> or actual defects.

## Tools the agent should reach for

1. `adt_get_source { object: "ZCL_PRICING_ENGINE", type: "class" }` for main
2. `adt_get_source { ..., include: "definitions" }` for the public methods
3. `adt_where_used` to see who calls it
4. `adt_get_source { ..., include: "testclasses" }` to check test coverage
5. `adt_run_unit_tests` if tests exist
6. `adt_run_atc` for static checks

## What to expect back

A short report: public surface, callers, test coverage, ATC findings filtered
to non-cosmetic ones, plus the agent's overall verdict.
