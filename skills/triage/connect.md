# Triage: the Azure DevOps tools didn't load

A chat starts before its MCP servers are connected, so the Azure DevOps server may still be starting.

1. While `ToolSearch` says a server is still connecting, run `spadework.js triage wait` (it waits 10 seconds), then the same `ToolSearch` again. Do this up to 6 times.
2. Once the four tools are loaded, go on with step 1 of the skill.
3. If they're still missing after that, or `ToolSearch` doesn't say a server is connecting, print "Azure DevOps didn't connect, so nothing was planned. Run triage again in a minute; if it fails again, check the server with /mcp.", run `spadework.js triage end --session <session>`, and stop.
