# Discover a project from a single package name

**Goal:** A new developer joins the team. Give them a tour of an unfamiliar
package: what's in it, what the entry points look like, what conventions are
followed.

## Prompt

> I just got handed the `ZLOCAL_INVOICE` package on the DEV system. Walk
> through it: list subpackages and their purpose, identify the main classes,
> show me the source of the most central one. Don't dump every line — give me
> the big picture and call out anything unusual.

## Tools the agent should reach for

1. `adt_list_packages` with `root: "ZLOCAL_INVOICE"` to walk the tree
2. `adt_browse_package` to look inside specific subpackages of interest
3. `adt_get_source` for one or two key classes
4. `adt_where_used` if it wants to identify "central" classes by callers

## What to expect back

A short tour: package tree, type breakdown, the agent's pick for the central
class plus a summary of its responsibilities. Any oddities (deprecated
includes, classes with no tests, etc.) flagged.
