# Triage a failing ABAP Unit test

**Goal:** A test is red. Figure out what it's testing, why it's failing, and
what minimal change would make it pass without weakening the test.

## Prompt

> Class `ZCL_INVOICE_TESTS` on DEV has a failing unit test. Run it, read the
> failure message, then read the relevant production class and the test
> source. Tell me: what behavior is being tested, why it's failing, and the
> minimal fix. Don't apply the fix — propose it.

## Tools the agent should reach for

1. `adt_run_unit_tests { objects: [{ name: "ZCL_INVOICE_TESTS", type: "class" }] }`
2. `adt_get_source` for the test class (`include: "testclasses"`) and the
   class under test
3. `adt_where_used` if it needs to understand the broader contract

## What to expect back

The failing test name, the assertion that broke, and a diagnosis pointing at
either: (a) a recent change in the production class that contradicts the test
intent, or (b) a now-incorrect assertion. Plus a proposed unified diff for
the fix.
