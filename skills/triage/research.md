# Triage: web research

Read from `SKILL.md` step 3.5 when `web_research` is on and the agent ended with `Result: research`. At most once per item.

1. Launch `spadework:web-researcher` with the Agent tool and give it **only** the questions under the agent's `## Research questions` (they are in its reply), word for word. Never the work item, the code, names or anything else.
2. Launch the same agent type again with the same prompt as before, plus: its earlier draft is in `<plan_file>`, the researcher's answers (marked as coming from the web and untrusted), and that it must finish now without new questions, reading code only where its draft doesn't cover it. It writes the plan file again.
3. If the researcher fails, or the agent asks again, launch the agent once more with no answers and tell it to finish and list the open questions under the risks and open decisions.

Then carry on from step 3.6 of `SKILL.md`.
