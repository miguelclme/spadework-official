---
name: new-spec
description: Create a design spec file (requirements, non-functional requirements, entities, API, high-level design, deep dives) to fill in and hand to /spadework:architect.
argument-hint: "<name> | -help"
disable-model-invocation: true
---

# Spadework: new spec

If the arguments are `-help` (or start with it), print exactly this and stop, creating nothing:

> **/spadework:new-spec**: create a design spec file
> Usage: `/spadework:new-spec <name>`
> Creates `docs/design/<name>.md` with empty sections: Requirements, Non-functional requirements, Core entities, API design, High-level design, Deep dives. That's the structure `/spadework:architect -file` expects.
> Example: `/spadework:new-spec order-processing` creates `docs/design/order-processing.md`. Fill it in, then run `/spadework:architect -file docs/design/order-processing.md`.

Arguments: $ARGUMENTS

1. If no name was given, ask for one before creating anything. It's used for the file name and the title.
2. Create `docs/design/<name>.md` in the current repo (create the `docs/design/` folder if needed) from the template below, with `<name>` in the title. If the file already exists, don't overwrite it: say so and ask whether to use another name or edit the existing file.
3. Tell the user the path, and that `/spadework:architect -file docs/design/<name>.md` will read it once it's filled in.

## Template

```
# <name>: design spec

## Requirements
<!-- What must this do, from the user's or the business's point of view? -->

## Non-functional requirements
<!-- Scale, latency, availability, consistency, compliance or data residency. -->

## Core entities
<!-- The main data objects and domain concepts. -->

## API design
<!-- The endpoints or contracts this exposes or uses: the shape only, not the implementation. -->

## High-level design
<!-- The components and how they connect: services, data stores, queues, workflow engines. -->

## Deep dives
<!-- Trade-offs to stress-test, open questions, improvements to consider later. -->
```
