<!--
The shape of a triage row's plan text. The planner agents return only the
content, as JSON fields (see "page-fields" in agents/feature-planner.md and
agents/bug-triager.md). lib/template.js puts the fields in here, so the page
looks the same on every run. This comment is not copied.

How it's filled:
- {{name}} is replaced by the field's text.
- A line that is a list marker plus one field ("- {{findings}}", "1. {{steps}}")
  is repeated once per item of a list field, numbered for "1.".
- A line whose field is empty or missing is dropped. A heading left with
  nothing under it is dropped too, so Questions disappears on a planned item.

Keep the headings "## Context", "## Code findings", "## Proposed solution"
and "## Risks and open decisions" exactly as they are: the developer agent
is told about them by name. If you add a {{field}}, add it to the page-fields block
in both agent files too (npm test checks this).
-->
## Context
{{context}}

## Code findings
- {{findings}}
Root cause: {{root_cause}}

## Proposed solution
1. {{steps}}

### Commit breakdown
1. {{commits}}

## Risks and open decisions
- {{decisions}}

## Questions
- {{questions}}
