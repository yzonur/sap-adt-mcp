# Cross-system release verification

**Goal:** Before / after a transport release, prove that what you intended to
move is what actually moved.

## Prompt — pre-release

> I'm about to release transport `E4DK900456` from DEV to QAS. Before I do:
> diff every object in that TR between DEV and QAS so I know exactly what will
> change on QAS. Flag anything where the DEV and QAS versions are already
> identical (i.e. nothing would actually change), and anything where the
> object is missing on QAS.

## Prompt — post-release

> I just released `E4DK900456` to QAS. Run the same diff again — every object
> in that TR should now be identical between DEV and QAS. If any aren't, that's
> a release problem.

## Tools the agent should reach for

- `adt_transport_diff { systemA: "DEV", systemB: "QAS", transport: "..." }`

## What to expect back

A categorized list:
- Identical (no change shipped)
- Updated (with summary of additions / removals per object)
- Missing on target (likely needs a parent TR)
- Errors fetching either side
